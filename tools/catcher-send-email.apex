// The Catch — let the app email Help reports to Anthony (11-02).
// Run in Production: Developer Console > Debug > Open Execute Anonymous Window > paste > Execute.
//
// Why: the "?" Help pop-up sends each bug report through Salesforce (the emailSimple action),
// because Cloudflare can't send email by itself. The app's login ("Catcher App",
// Minimum Access - API Only Integrations) has no "Send Email" permission, so without this the
// report is only kept in the app's own storage and the tablet says "It's saved".
//
// This turns on ONE system permission in Catcher_App_Access. The sender is the org-wide address
// info@cultureapparel.com (already allowed for all profiles). Also check
// Setup > Deliverability > Access level = "All email".
// Safe to run again. Undo: set the line below to false and run it again.
PermissionSet ps = [SELECT Id FROM PermissionSet WHERE Name = 'Catcher_App_Access' LIMIT 1];
ps.PermissionsEmailSingle = true;
update ps;
System.debug('Send Email = ' + [SELECT PermissionsEmailSingle FROM PermissionSet WHERE Id = :ps.Id].PermissionsEmailSingle);
