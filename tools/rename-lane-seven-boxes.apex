// The Catch — rename Lane Seven boxes that were saved as "Tees" (Anthony 11-02).
// Run in Production: Developer Console > Debug > Open Execute Anonymous Window > paste > Execute.
//
// Why: before 11-02 the app named every box from the product NAME only, and "Lane Seven LS16004"
// has no garment word in it, so boxes came out "Tees N". The app now knows the Lane Seven styles.
// This fixes the boxes already saved. Only the Garment Type word changes; the box number, sizes,
// counts and everything else stay as they are.
//
//   21495-1  Black Lane Seven LS16004 (crewneck)   Tees N -> Crewnecks N   (40 boxes)
//   20847-7  Lane Seven LS14001 (hoodie)           Tees N -> Hoodies N     (8 boxes)
//   21582    Lane Seven LS14004 (crewneck)         Tees N -> Crewnecks N   (3 boxes)
//
// Run it once with DRY_RUN = true: it only lists what it would change (Debug log, filter "RENAME").
// Then set DRY_RUN = false and run it again. Safe to run again: boxes already renamed are skipped.
Boolean DRY_RUN = true;

// order Id => { new word, text the box's "Quantity + Size Counted" must contain (blank = any) }
Map<Id, List<String>> plan = new Map<Id, List<String>>{
    '801Ri000013xCW8IAM' => new List<String>{ 'Crewnecks', 'Lane Seven LS16004' },   // 21495-1 (also has Cotton Collective crews)
    '801Ri000014JRw9IAG' => new List<String>{ 'Hoodies',   '' },                     // 20847-7 (LS14001 only)
    '801Ri0000141h3qIAA' => new List<String>{ 'Crewnecks', '' }                      // 21582 (LS14004 only)
};

List<Order_Packaging__c> changes = new List<Order_Packaging__c>();
for (Order_Packaging__c b : [SELECT Id, Name, Order__c, Quantity_Size_Counted__c FROM Order_Packaging__c
                             WHERE Order__c IN :plan.keySet() AND Name LIKE 'Tees%' ORDER BY Order__c, CreatedDate]) {
    List<String> p = plan.get(b.Order__c);
    String must = p[1];
    if (String.isNotBlank(must) && (b.Quantity_Size_Counted__c == null || !b.Quantity_Size_Counted__c.contains(must))) continue;
    Matcher m = Pattern.compile('^Tees(\\s+\\d+)?$').matcher(b.Name);
    if (!m.matches()) continue;   // e.g. "Tees + Hats 3": leave mixed boxes alone
    String newName = p[0] + (m.group(1) == null ? '' : m.group(1));
    System.debug('RENAME ' + b.Id + ': ' + b.Name + ' -> ' + newName);
    changes.add(new Order_Packaging__c(Id = b.Id, Name = newName));
}
System.debug('RENAME total: ' + changes.size() + (DRY_RUN ? ' (dry run: nothing changed)' : ''));
if (!DRY_RUN && !changes.isEmpty()) update changes;
