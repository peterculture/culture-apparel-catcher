/**
 * GET /api/box-types
 * The box types offered on the tablet = the active values of
 * Order_Packaging__c.Packaging_Type__c in Salesforce, in Salesforce's order.
 * Add or retire a box type in Salesforce and the tablet follows.
 */
import { json, errorResponse, picklistValues, orgFor } from "./_sf.js";
import { requireUser } from "./_session.js";

export async function onRequestGet({ request, env: siteEnv }) {
  // Which Salesforce org this request uses, fixed for the whole request (11-12, see _sf.js).
  const org = await orgFor(request, siteEnv);
  if (org.response) return org.response;
  const env = org.env;
  const auth = await requireUser(request, env);
  if (auth.response) return auth.response;
  try {
    const types = await picklistValues(env, "Order_Packaging__c", "Packaging_Type__c");
    return json({ types });
  } catch (err) {
    return errorResponse(err);
  }
}
