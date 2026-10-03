//! Smart Paste: analysing a paste, and committing what the review sheet accepted.

use super::*;

impl Vault {
    // ------------------------------------------------------------ smart paste

    /// Analyse pasted text and stage its secrets for review.
    ///
    /// Nothing is written to the database by this call.
    pub fn analyze_paste(&mut self, text: &str, source: SourceKind) -> Result<PasteAnalysis> {
        let now = OffsetDateTime::now_utc().unix_timestamp();
        let inner = self.unlocked_mut()?;
        let lookup = StoreLookup {
            store: &inner.store,
        };
        let (analysis, secrets) = pipeline::analyze(text, source, &inner.index_key, &lookup, now)?;
        inner.staging.insert(
            analysis.analysis_id,
            StagedPaste {
                analysis: analysis.clone(),
                secrets,
            },
        );
        Ok(analysis)
    }

    /// Discard a staged analysis without saving it.
    pub fn discard_analysis(&mut self, analysis_id: Uuid) -> Result<()> {
        self.unlocked_mut()?.staging.remove(&analysis_id);
        Ok(())
    }

    /// Apply a reviewed analysis.
    ///
    /// Returns [`CoreError::Invalid`] if a critical warning is outstanding and
    /// the submission did not acknowledge it, so the block cannot be bypassed
    /// by a frontend that forgets to check.
    pub fn commit_review(&mut self, submission: &ReviewSubmission) -> Result<CommitOutcome> {
        // Peek before removing: a refused commit must leave the analysis staged
        // so the user can acknowledge and retry without re-pasting.
        {
            let inner = self.unlocked()?;
            let staged = inner
                .staging
                .get(&submission.analysis_id)
                .ok_or_else(|| CoreError::StaleAnalysis(submission.analysis_id.to_string()))?;
            if staged.analysis.blocks_save && !submission.acknowledge_critical {
                return Err(CoreError::Invalid(
                    "a critical warning must be acknowledged before saving".into(),
                ));
            }
        }

        let StagedPaste { analysis, secrets } = {
            let inner = self.unlocked_mut()?;
            inner
                .staging
                .remove(&submission.analysis_id)
                .ok_or_else(|| CoreError::StaleAnalysis(submission.analysis_id.to_string()))?
        };

        let mut outcome = CommitOutcome::default();
        let resolved = self.resolve_chain(&analysis, submission, &mut outcome)?;

        // Entity index -> the secret row it produced, so accepted relations can
        // be anchored to real ids.
        let mut secret_ids: HashMap<usize, Uuid> = HashMap::new();

        for decision in &submission.decisions {
            let index = decision.entity_index;
            let entity = analysis
                .entities
                .get(index)
                .ok_or_else(|| CoreError::Invalid(format!("no entity at index {index}")))?;
            let Some(value) = secrets.values.get(index).and_then(|v| v.as_ref()) else {
                continue;
            };
            let recommended = analysis
                .recommendations
                .get(index)
                .ok_or_else(|| CoreError::Invalid(format!("no recommendation at index {index}")))?;

            let effective = match &decision.decision {
                EntityDecision::Skip => {
                    outcome.entities_skipped += 1;
                    continue;
                }
                EntityDecision::Accept => recommended.clone(),
                EntityDecision::CreateNew => RecommendedAction::Create,
                EntityDecision::Change { secret_id } => RecommendedAction::Update {
                    secret_id: *secret_id,
                },
            };

            let name = decision
                .name_override
                .clone()
                .unwrap_or_else(|| entity.label.clone());
            let kind = entity.secret_kind.unwrap_or(match entity.kind {
                crate::paste::detect::DetectedKind::EnvVar => SecretKind::EnvVar,
                _ => SecretKind::GenericApiKey,
            });

            match effective {
                RecommendedAction::Skip { .. } => outcome.entities_skipped += 1,
                RecommendedAction::Update { secret_id } => {
                    self.write_secret_value(secret_id, value)?;
                    secret_ids.insert(index, secret_id);
                    outcome.secrets_updated += 1;
                }
                RecommendedAction::Create => {
                    // A secret goes against the provider resource when it is
                    // that provider's credential, because that is what it
                    // authenticates to. Anything else in the paste -- a Stripe
                    // key next to a Supabase URL -- is filed directly against
                    // the project.
                    if resolved.service_project.is_none() && resolved.project.is_none() {
                        return Err(CoreError::Invalid(
                            "choose a project before saving: these credentials have nothing to \
                             attach to"
                                .into(),
                        ));
                    }
                    let names_resource =
                        analysis.chain.service_project.as_ref().is_some_and(|sp| {
                            entity.project_ref.as_deref() == Some(sp.label.as_str())
                        });
                    let on_resource = resolved.service_project.is_some()
                        && (resolved.project.is_none()
                            || names_resource
                            || entity.provider == analysis.provider);
                    let record = self.insert_secret(
                        if on_resource { None } else { resolved.project },
                        if on_resource {
                            resolved.service_project
                        } else {
                            None
                        },
                        kind,
                        &name,
                        entity.environment,
                        value,
                    )?;
                    secret_ids.insert(index, record.id);
                    outcome.secrets_created += 1;
                    self.attach_provenance(
                        EntityRef::new(EntityKind::Secret, record.id),
                        &analysis.provenance,
                    )?;
                }
            }
        }

        if let Some(project_id) = resolved.project {
            if !outcome.touched_project_ids.contains(&project_id) {
                outcome.touched_project_ids.push(project_id);
            }
        }

        // Record the relations the user kept ticked, now that ids exist.
        for index in &submission.accepted_relations {
            let Some(relation) = analysis.proposed_relations.get(*index) else {
                continue;
            };
            let (Some(from), Some(to)) = (
                resolve_endpoint(&relation.from, &resolved, &secret_ids),
                resolve_endpoint(&relation.to, &resolved, &secret_ids),
            ) else {
                // An endpoint referring to something the user skipped has no row
                // to point at, so the relation is dropped with it.
                continue;
            };
            self.unlocked()?
                .store
                .create_relation(from, to, relation.kind, &relation.evidence)?;
            outcome.relations_created += 1;
        }

        if let (Some(parsed), Some(account_id)) = (&analysis.subscription, resolved.account) {
            self.unlocked()?
                .store
                .create_subscription(account_id, parsed)?;
        }

        let inner = self.unlocked()?;
        inner.store.audit(
            "paste.commit",
            None,
            None,
            &format!(
                "Saved {} new and {} rotated secrets, skipped {}",
                outcome.secrets_created, outcome.secrets_updated, outcome.entities_skipped
            ),
        )?;
        Ok(outcome)
    }

    /// Turn the proposed chain plus the user's answers into concrete rows.
    ///
    /// The rule this method exists to enforce: an organization is created only
    /// when the user named one or confirmed one. A rung DevLedger is unsure
    /// about is left empty and surfaces under Needs attention afterwards.
    pub(super) fn resolve_chain(
        &mut self,
        analysis: &PasteAnalysis,
        submission: &ReviewSubmission,
        outcome: &mut CommitOutcome,
    ) -> Result<ResolvedChain> {
        let chain: &ProposedChain = &analysis.chain;
        let provider = &analysis.provider;
        let mut resolved = ResolvedChain::default();

        let needs_account = chain.service_project.is_some() || chain.account.is_some();

        // --- identity
        resolved.identity = match pipeline::answer_for(&submission.answers, Q_IDENTITY) {
            Some(AnswerChoice::Existing { entity }) => Some(entity.id),
            Some(AnswerChoice::NewNamed { name }) => Some(self.identity_for_email(name, outcome)?),
            Some(AnswerChoice::Unknown) | None => match &chain.identity {
                Some(node) => Some(self.identity_for_email(&node.label, outcome)?),
                None if needs_account => Some(self.unidentified_identity(outcome)?),
                None => None,
            },
        };

        // --- account
        //
        // One identity may hold several accounts with the same provider: two
        // Supabase accounts signed in with different addresses is a normal
        // thing to have, and the whole point of this program is to keep track
        // of exactly that. A paste that only names the provider cannot say
        // which one it means. Rather than pick silently, the oldest is used and
        // the choice is reported back, so a wrong guess is visible and can be
        // corrected from the map instead of quietly filing a production key
        // under the wrong account.
        if needs_account && *provider != Provider::Unknown {
            if let Some(identity_id) = resolved.identity {
                let existing = self.unlocked()?.store.accounts_for(identity_id, provider)?;
                resolved.account = Some(match existing.len() {
                    0 => {
                        outcome.accounts_created += 1;
                        self.unlocked()?
                            .store
                            .create_account(identity_id, provider, None, provider.label())?
                            .id
                    }
                    1 => existing[0].id,
                    n => {
                        outcome.notes.push(format!(
                            "This identity holds {n} {} accounts. Filed under \"{}\", the \
                             oldest one. Move it from the map if that is wrong.",
                            provider.label(),
                            existing[0].label
                        ));
                        existing[0].id
                    }
                });
            }
        }

        // --- organization
        resolved.organization = match pipeline::answer_for(&submission.answers, Q_ORGANIZATION) {
            Some(AnswerChoice::Existing { entity }) => Some(entity.id),
            Some(AnswerChoice::NewNamed { name }) => match resolved.account {
                Some(account_id) => Some(self.organization_named(account_id, name, outcome)?),
                None => None,
            },
            // No answer, or an explicit "I don't know": only an organization
            // that already exists is used. A weakly-guessed name is never
            // created on the user's behalf.
            Some(AnswerChoice::Unknown) | None => {
                chain.organization.as_ref().and_then(|n| n.existing_id)
            }
        };

        // --- service project
        if let Some(node) = &chain.service_project {
            resolved.service_project = Some(match node.existing_id {
                Some(id) => {
                    // A resource whose organization was unknown and is now known
                    // gets filled in, but a known one is never overwritten.
                    if let Some(org_id) = resolved.organization {
                        let sp = self.unlocked()?.store.service_project(id)?;
                        if sp.is_some_and(|s| s.organization_id.is_none()) {
                            self.unlocked()?
                                .store
                                .set_service_project_organization(id, Some(org_id))?;
                        }
                    }
                    id
                }
                None => match resolved.account {
                    Some(account_id) => {
                        outcome.service_projects_created += 1;
                        if resolved.organization.is_none() {
                            outcome.left_unassigned += 1;
                        }
                        self.unlocked()?
                            .store
                            .create_service_project(
                                account_id,
                                resolved.organization,
                                provider,
                                Some(&node.label),
                                &node.label,
                                None,
                                Environment::Unknown,
                            )?
                            .id
                    }
                    None => return Ok(resolved),
                },
            });
        }

        // --- DevLedger project
        resolved.project = match pipeline::answer_for(&submission.answers, Q_PROJECT) {
            Some(AnswerChoice::Existing { entity }) => Some(entity.id),
            Some(AnswerChoice::NewNamed { name }) => Some(self.project_named(name, outcome)?),
            Some(AnswerChoice::Unknown) => None,
            None => match submission.target_project_id {
                Some(id) => Some(id),
                None => match &chain.project {
                    Some(node) => match node.existing_id {
                        Some(id) => Some(id),
                        // Same rule as organizations: a weak guess is not acted
                        // on without confirmation.
                        // A guess the user never confirmed is not acted on.
                        None if node.evidence.level.is_at_least(EvidenceLevel::Heuristic) => {
                            Some(self.project_named(&node.label, outcome)?)
                        }
                        None => None,
                    },
                    None => None,
                },
            },
        };

        // --- record the chain itself
        //
        // These four relations are consequences of what the user confirmed, not
        // optional suggestions, so they are written whatever the relation
        // checkboxes said. `create_relation` ignores duplicates, so a proposal
        // the user also ticked is a no-op rather than a second row.
        let confirmed = Evidence::new(
            EvidenceLevel::Strong,
            "chain.confirmed",
            "Confirmed in the review sheet",
        );
        let store_links: [(Option<EntityRef>, Option<EntityRef>, RelationKind); 4] = [
            (
                resolved
                    .identity
                    .map(|id| EntityRef::new(EntityKind::Identity, id)),
                resolved
                    .account
                    .map(|id| EntityRef::new(EntityKind::Account, id)),
                RelationKind::Owns,
            ),
            (
                resolved
                    .account
                    .map(|id| EntityRef::new(EntityKind::Account, id)),
                resolved
                    .organization
                    .map(|id| EntityRef::new(EntityKind::Organization, id)),
                RelationKind::MemberOf,
            ),
            (
                resolved
                    .organization
                    .map(|id| EntityRef::new(EntityKind::Organization, id)),
                resolved
                    .service_project
                    .map(|id| EntityRef::new(EntityKind::ServiceProject, id)),
                RelationKind::Contains,
            ),
            (
                resolved
                    .service_project
                    .map(|id| EntityRef::new(EntityKind::ServiceProject, id)),
                resolved
                    .project
                    .map(|id| EntityRef::new(EntityKind::Project, id)),
                RelationKind::UsedBy,
            ),
        ];
        for (from, to, kind) in store_links {
            let (Some(from), Some(to)) = (from, to) else {
                continue;
            };
            self.unlocked()?
                .store
                .create_relation(from, to, kind, &confirmed)?;
        }

        Ok(resolved)
    }

    pub(super) fn identity_for_email(
        &self,
        email: &str,
        outcome: &mut CommitOutcome,
    ) -> Result<Uuid> {
        let inner = self.unlocked()?;
        let lowered = email.trim().to_ascii_lowercase();
        let bi = blind_index::blind_index(&inner.index_key, DOMAIN_IDENTITY_EMAIL, &lowered)?;
        if let Some(id) = inner.store.identity_id_by_email_index(&bi)? {
            return Ok(id);
        }
        outcome.identities_created += 1;
        Ok(inner
            .store
            .create_identity(&lowered, Some(&lowered), Some(&bi))?
            .id)
    }

    /// An identity for an account whose owner is not known.
    ///
    /// Deliberately has no email, which puts it on the Needs attention list
    /// rather than pretending DevLedger knows who this is.
    pub(super) fn unidentified_identity(&self, outcome: &mut CommitOutcome) -> Result<Uuid> {
        const LABEL: &str = "Unidentified";
        let inner = self.unlocked()?;
        if let Some(existing) = inner
            .store
            .list_identities()?
            .into_iter()
            .find(|i| i.email.is_none() && i.label == LABEL)
        {
            return Ok(existing.id);
        }
        outcome.identities_created += 1;
        Ok(inner.store.create_identity(LABEL, None, None)?.id)
    }

    pub(super) fn organization_named(
        &self,
        account_id: Uuid,
        name: &str,
        outcome: &mut CommitOutcome,
    ) -> Result<Uuid> {
        let inner = self.unlocked()?;
        if let Some(existing) = inner.store.organization_by_name(account_id, name)? {
            return Ok(existing.id);
        }
        outcome.organizations_created += 1;
        Ok(inner.store.create_organization(account_id, None, name)?.id)
    }

    pub(super) fn project_named(&self, name: &str, outcome: &mut CommitOutcome) -> Result<Uuid> {
        let inner = self.unlocked()?;
        if let Some(existing) = inner.store.project_by_name(name)? {
            return Ok(existing.id);
        }
        outcome.projects_created += 1;
        Ok(inner.store.create_project(name, None)?.id)
    }

    pub(super) fn attach_provenance(
        &self,
        entity: EntityRef,
        provenance: &Provenance,
    ) -> Result<()> {
        self.unlocked()?.store.record_provenance(entity, provenance)
    }
}
