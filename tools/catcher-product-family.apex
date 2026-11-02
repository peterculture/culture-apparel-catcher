// The Catch — let the app read Product Family (11-02), for box names (Hoodies / Crewnecks / Long Sleeves...).
// Run in Production: Developer Console > Debug > Open Execute Anonymous Window > paste > Execute.
// Read only. The same line is in tools/catcher-app-access.apex; this is the short version.
PermissionSet ps = [SELECT Id FROM PermissionSet WHERE Name = 'Catcher_App_Access' LIMIT 1];
List<FieldPermissions> have = [SELECT Id FROM FieldPermissions WHERE ParentId = :ps.Id AND Field = 'Product2.Family'];
FieldPermissions fp = have.isEmpty() ? new FieldPermissions(ParentId = ps.Id, SobjectType = 'Product2', Field = 'Product2.Family') : have[0];
fp.PermissionsRead = true;
fp.PermissionsEdit = false;
upsert fp;
System.debug('Product2.Family readable: ' + [SELECT PermissionsRead FROM FieldPermissions WHERE Id = :fp.Id].PermissionsRead);
