// The Catch — let the app write the box count on orders that are already activated (10-30).
// Run in Production: Developer Console > Debug > Open Execute Anonymous Window > paste > Execute.
//
// Why: Salesforce activates an order when its Status moves to Sent Tracking. From then on, only
// users with "Edit Activated Orders" can change it. If the crew ships an order before a catcher
// taps FINISH CATCHING, the app can't write Order.Packaging_Count__c without this permission.
// (Without it the app now lets the order go from the board anyway, but the count stays blank.)
//
// This turns on ONE system permission in Catcher_App_Access. Field access is unchanged: the app can
// still only edit Packaging_Count__c, TotalQtyMisprints__c and Misprint_Details__c on an Order.
// Safe to run again. Undo: set the line below to false and run it again.
PermissionSet ps = [SELECT Id, PermissionsEditActivatedOrders FROM PermissionSet WHERE Name = 'Catcher_App_Access' LIMIT 1];
ps.PermissionsEditActivatedOrders = true;
update ps;
System.debug('Catcher_App_Access: Edit Activated Orders = '
    + [SELECT PermissionsEditActivatedOrders FROM PermissionSet WHERE Id = :ps.Id].PermissionsEditActivatedOrders);
