# FMIS

## Accounts

- The initial owner username is `owner` and the initial password is `1234`.
- Sign in as the owner and open **Settings** to register barista accounts.
- Each new barista account starts with the temporary password `barista123`. The barista must change it in **Settings** before using the rest of the app.
- Owners and baristas can change their passwords from **Settings**. Sales and inventory are shared. Each sale is attributed to the account that took the order; baristas see only their own ledger entries, and only the owner can see recorded-by details and audit records.

## Inventory recipes and expiration notices

- On **Menu & prices**, expand an item's ingredient list to set the amount and recipe unit of each ingredient independently per product. The entered amount is deducted from inventory for each item sold; no conversion factor is used. Adding or saving an ingredient keeps that item's recipe list expanded. Cup-based menu items start with one cup per item.
- Owners can edit an inventory item's unit from **Inventory**. Changing the unit updates its label but does not convert stock or recipe amounts; review affected recipes after a unit change.
- Orders are not recorded if the configured recipe requires more stock than is available.
- Owners can set or edit an inventory item's expiration date on **Inventory**. The system shows an in-app notice on owner pages when stocked items are expired or will expire within seven days.
- Expiration is tracked as one date per inventory item; restocking can update that tracked date.
- Sale, wastage, and save actions submit directly without browser confirmation pop-ups.

## Demand forecast

- Owners and baristas can open **Forecast** to view projected ingredient run-out dates and likely top-selling cup products for the current week and month.
- Ingredient projections use the Cumulative Demand Run-Out method: recorded ingredient consumption is averaged across up to the last 30 calendar days, including days with no sales, then compared with current stock. Recipe consumption must have been recorded for an ingredient to produce a run-out estimate.
- Product projections add current-period sales through yesterday to the recent average daily sales multiplied by the number of days remaining in the week or month. Add-ons are excluded.
- Forecasts are estimates based on recorded history, not guarantees. New or changed recipes, missing recipe entries, or changed incompatible units can reduce the available history or prevent a stock estimate.