// Dryer Catch — give the "Catcher App" integration user exactly the access the app needs.
// Run in Production: Developer Console > Debug > Open Execute Anonymous Window > paste > Execute.
//
// All or nothing: if any line fails, Salesforce undoes everything this script did
// and shows the error. Safe to run again: it updates what already exists.
//
// What it grants (and nothing else):
//   Order            Read + View All. Edit ONLY TotalQtyMisprints__c, Misprint_Details__c and Packaging_Count__c.
//   Order Product    Read Size__c and Color__c (Order Products follow the Order's access).
//   Order Packaging  Read + Create + Edit + Delete + View All (Edit Box / Delete Box; the app allows
//                    changes only within 7 days of a box being created).
//   Account, Product, Price Book, the Printer's object   Read only.
String USERNAME_PREFIX = 'catcher.app@';
String PS_NAME = 'Catcher_App_Access';

User u = [SELECT Id, Username, Profile.Name FROM User WHERE Username LIKE :(USERNAME_PREFIX + '%') AND IsActive = true LIMIT 1];

// The permission set license that comes with a "Salesforce Integration" user.
List<PermissionSetLicense> psls = [SELECT Id FROM PermissionSetLicense WHERE DeveloperName = 'SalesforceAPIIntegrationPsl' LIMIT 1];
Id pslId = psls.isEmpty() ? null : psls[0].Id;
if (pslId != null && [SELECT COUNT() FROM PermissionSetLicenseAssign WHERE AssigneeId = :u.Id AND PermissionSetLicenseId = :pslId] == 0) {
    insert new PermissionSetLicenseAssign(AssigneeId = u.Id, PermissionSetLicenseId = pslId);
}

List<PermissionSet> found = [SELECT Id FROM PermissionSet WHERE Name = :PS_NAME LIMIT 1];
PermissionSet ps;
if (found.isEmpty()) {
    ps = new PermissionSet(Name = PS_NAME, Label = 'Catcher App Access',
        Description = 'Dryer Catch tablet app (culture-apparel-catcher). Read orders, log boxes, record misprints.',
        PermissionsApiEnabled = false, LicenseId = pslId);   // API access comes from the user's profile (Minimum Access - API Only Integrations)
    insert ps;
} else {
    ps = new PermissionSet(Id = found[0].Id);
}

// ---- objects ----
// Delete is allowed on boxes ONLY (Delete Box, 7-day review window, enforced by the app).
Set<String> CAN_DELETE = new Set<String>{ 'Order_Packaging__c' };
// name => {read, create, edit, viewAll}
Map<String, List<Boolean>> objs = new Map<String, List<Boolean>>{
    'Order'              => new List<Boolean>{ true, false, true,  true },
    'Order_Packaging__c' => new List<Boolean>{ true, true,  true,  true },   // edit: Edit Box (7-day review window, enforced by the app)
    'Account'            => new List<Boolean>{ true, false, false, true },
    'Product2'           => new List<Boolean>{ true, false, false, true },
    'Pricebook2'         => new List<Boolean>{ true, false, false, false }   // Order Products are only visible with Price Book read
};
// Whatever object Order.Printer__c points at (read only).
for (Schema.SObjectType t : Schema.SObjectType.Order.fields.getMap().get('Printer__c').getDescribe().getReferenceTo()) {
    String n = t.getDescribe().getName();
    if (!objs.containsKey(n)) objs.put(n, new List<Boolean>{ true, false, false, true });
}
Map<String, ObjectPermissions> haveObj = new Map<String, ObjectPermissions>();
for (ObjectPermissions op : [SELECT Id, SobjectType FROM ObjectPermissions WHERE ParentId = :ps.Id]) haveObj.put(op.SobjectType, op);
List<ObjectPermissions> objRows = new List<ObjectPermissions>();
List<String> noViewAll = new List<String>();
for (String n : objs.keySet()) {
    List<Boolean> f = objs.get(n);
    ObjectPermissions op = haveObj.containsKey(n) ? haveObj.get(n) : new ObjectPermissions(ParentId = ps.Id, SobjectType = n);
    op.PermissionsRead = f[0]; op.PermissionsCreate = f[1]; op.PermissionsEdit = f[2];
    op.PermissionsViewAllRecords = f[3]; op.PermissionsDelete = CAN_DELETE.contains(n); op.PermissionsModifyAllRecords = false;
    Database.UpsertResult r = Database.upsert(op, false);
    if (!r.isSuccess() && op.PermissionsViewAllRecords) {
        // This license won't allow "View All" on this object: keep the rest, without it.
        op.PermissionsViewAllRecords = false;
        r = Database.upsert(op, false);
        if (r.isSuccess()) noViewAll.add(n);
    }
    if (!r.isSuccess()) {
        throw new IllegalArgumentException('Could not grant access to ' + n + ': ' + r.getErrors()[0].getMessage());
    }
    objRows.add(op);
}

// ---- fields ----  'Object.Field' => can edit?
Map<String, Boolean> fields = new Map<String, Boolean>{
    'Order.GOA_Order_Number__c' => false, 'Order.Order_Substatus__c' => false, 'Order.Printer__c' => false,
    'Order.Print_Date__c' => false, 'Order.Specifications_for_Printing__c' => false, 'Order.Artwork_URL__c' => false,
    'Order.TotalQtyMisprints__c' => true, 'Order.Misprint_Details__c' => true,
    'Order.Packaging_Count__c' => true,
    'OrderItem.Size__c' => false, 'OrderItem.Color__c' => false,
    'Order_Packaging__c.Order__c' => true, 'Order_Packaging__c.Packaging_Type__c' => true,
    'Order_Packaging__c.Packaging_Quantity__c' => true, 'Order_Packaging__c.Quantity_Size_Counted__c' => true
};
Map<String, FieldPermissions> haveFld = new Map<String, FieldPermissions>();
for (FieldPermissions fp : [SELECT Id, Field FROM FieldPermissions WHERE ParentId = :ps.Id]) haveFld.put(fp.Field, fp);
List<FieldPermissions> fldRows = new List<FieldPermissions>();
List<String> skipped = new List<String>();
for (String key : fields.keySet()) {
    String obj = key.substringBefore('.'), fld = key.substringAfter('.');
    Schema.SObjectField sf = Schema.getGlobalDescribe().get(obj).getDescribe().fields.getMap().get(fld);
    if (sf == null) { throw new IllegalArgumentException('Field not found in this org: ' + key); }
    Schema.DescribeFieldResult d = sf.getDescribe();
    if (!d.isPermissionable()) { skipped.add(key); continue; }   // always visible, nothing to grant
    FieldPermissions fp = haveFld.containsKey(key) ? haveFld.get(key) : new FieldPermissions(ParentId = ps.Id, SobjectType = obj, Field = key);
    fp.PermissionsRead = true;
    fp.PermissionsEdit = fields.get(key) && d.isUpdateable() && !d.isCalculated();
    fldRows.add(fp);
}
upsert fldRows;

if ([SELECT COUNT() FROM PermissionSetAssignment WHERE AssigneeId = :u.Id AND PermissionSetId = :ps.Id] == 0) {
    insert new PermissionSetAssignment(AssigneeId = u.Id, PermissionSetId = ps.Id);
}

System.debug('CATCHER APP ACCESS DONE for ' + u.Username + ' (' + u.Profile.Name + '): '
    + objRows.size() + ' objects, ' + fldRows.size() + ' fields. No View All allowed on: ' + noViewAll
    + '. Always-visible fields skipped: ' + skipped);
