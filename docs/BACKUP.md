# Back up and restore a vault

## Windows desktop

The desktop app currently uses a folder backup. It has no Backup or Restore
button. The vault is stored at:

```text
%APPDATA%\dev.devledger.desktop\vault
```

Paste `%APPDATA%\dev.devledger.desktop` into File Explorer's address bar to
find it. This is the application's data directory followed by `vault`.

To make a backup:

1. Lock DevLedger, then close the app before copying any files.
2. Copy the entire `vault` folder to your backup location. Keep its files
   together: `vault.json` contains the parameters needed to open the encrypted
   `devledger.db`. Neither file alone is a usable backup.
3. Keep the passphrase available separately. The backup opens with the same
   passphrase; a forgotten passphrase cannot be recovered.

To restore on the same computer or another Windows computer:

1. Close DevLedger. If necessary, launch it once and close it to create the
   application data directory.
2. Open `%APPDATA%\dev.devledger.desktop`. If it already contains a `vault`
   folder, rename that folder to an unused name such as `vault-before-restore`
   so the existing data remains available.
3. Copy the backed-up `vault` folder into that directory. Its `vault.json` and
   `devledger.db` should sit directly inside `vault`, without another nested
   `vault` folder.
4. Open DevLedger and unlock with the backup's passphrase. Check the projects,
   accounts and connections before discarding any older copy.

The integration test `core_lifecycle` checks a corrected project connection,
environment-specific `.env` export, restart, and restoration of both closed
vault files into a fresh directory. It also checks that a wrong passphrase
cannot unlock the restored data.

## Browser app

Use **Backup** to download the encrypted `.devledger` file. In a browser
profile with no existing DevLedger vault, choose **Restore backup**, select
the file, and unlock with its original passphrase. Restore refuses to replace
an existing browser vault.

Browser backups and desktop vault folders use different formats and cannot
be restored into each other.
