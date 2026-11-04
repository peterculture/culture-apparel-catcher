// The Catch — let the app read and write Order "Size Changes" (11-04), for SIZES CHANGED.
// Run in Production: Developer Console > Debug > Open Execute Anonymous Window > paste > Execute.
//
// FIRST create the field (Apex can't): Setup > Object Manager > Order > Fields & Relationships > New
//   Data Type: Long Text Area · Field Label: Size Changes · Length: 32,768 · # Visible Lines: 5
//   Field Name: Size_Changes (API name Size_Changes__c) · visible to your profiles · add it to the Order layout.
// Then run this. It gives the app's login (Catcher_App_Access) Read + Edit on that one field.
// Until both are done the app hides the SIZES CHANGED button; nothing breaks.
// Safe to run again. Undo: set both to false and run it again.
PermissionSet ps = [SELECT Id FROM PermissionSet WHERE Name = 'Catcher_App_Access' LIMIT 1];
List<FieldPermissions> have = [SELECT Id FROM FieldPermissions WHERE ParentId = :ps.Id AND Field = 'Order.Size_Changes__c'];
FieldPermissions fp = have.isEmpty() ? new FieldPermissions(ParentId = ps.Id, SobjectType = 'Order', Field = 'Order.Size_Changes__c') : have[0];
fp.PermissionsRead = true;
fp.PermissionsEdit = true;
upsert fp;
FieldPermissions chk = [SELECT PermissionsRead, PermissionsEdit FROM FieldPermissions WHERE Id = :fp.Id];
System.debug('Order.Size_Changes__c: Read = ' + chk.PermissionsRead + ', Edit = ' + chk.PermissionsEdit);
