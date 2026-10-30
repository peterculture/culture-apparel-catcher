// The Catch — let the app write the box count on orders that are already activated (10-30).
// Run in Production: Developer Console > Debug > Open Execute Anonymous Window > paste > Execute.
//
// Why: Salesforce activates an order when its Status moves to Sent Tracking. From then on, only
// users with "Edit Activated Orders" can change it. If the crew ships an order before a catcher
// taps FINISH CATCHING, the app can't write Order.Packaging_Count__c without this permission.
// (Without it the app now lets the order go from the board anyway, but the count stays blank.)
//
// This turns on two system permissions in Catcher_App_Access. Salesforce requires Activate Order for
// Edit Activated Orders (10-30: "Permission EditActivatedOrders depends on permission(s): ActivateOrder").
// The app never changes an order's Status; field access is unchanged: it can still only edit
// Packaging_Count__c, TotalQtyMisprints__c and Misprint_Details__c on an Order.
// Safe to run again. Undo: set both lines to false and run it again.
PermissionSet ps = [SELECT Id FROM PermissionSet WHERE Name = 'Catcher_App_Access' LIMIT 1];
ps.PermissionsActivateOrder = true;          // required by Edit Activated Orders
ps.PermissionsEditActivatedOrders = true;
update ps;
PermissionSet chk = [SELECT PermissionsActivateOrder, PermissionsEditActivatedOrders FROM PermissionSet WHERE Id = :ps.Id];
System.debug('Activate Order = ' + chk.PermissionsActivateOrder + ', Edit Activated Orders = ' + chk.PermissionsEditActivatedOrders);
