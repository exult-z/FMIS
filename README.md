# FMIS

## Selenium browser tests

- Install dependencies with `npm install`.
- Install Google Chrome or Chromium; Selenium Manager will locate or download the compatible ChromeDriver when the tests run.
- Run the end-to-end system test with `npm test` (or `npm run test:selenium`).
- The test starts an isolated FMIS server and SQLite database in a temporary directory, then removes them after the run. It does not use or modify the normal application database.

## Accounts

- The initial owner username is `owner` and the initial password is `1234`.
- Sign in as the owner and open **Settings** to register or remove barista accounts. Removing an account revokes its active sessions.
- Each new barista account starts with the temporary password `barista123`. The barista must change it in **Settings** before using the rest of the app.
- Owners and baristas can change their passwords from **Settings**. Sales and inventory are shared. Each sale is attributed to the account that took the order; baristas see only their own ledger entries, and only the owner can see recorded-by details and audit records.

## Inventory recipes, costs, and expiration alerts

- On **Menu & prices**, expand an item's ingredient list to set the amount and recipe unit of each ingredient independently per product. The entered amount is deducted from inventory for each item sold; no conversion factor is used. Adding or saving an ingredient keeps that item's recipe list expanded. Cup-based menu items start with one cup per item.
- Owners can enter purchase quantities and total costs when adding or restocking inventory. Restocks update a weighted-average cost per inventory unit. Once all recipe ingredients have costs, menu prices are calculated to provide at least a 15% profit margin (ingredient cost divided by 0.85), rounded up to a whole peso.
- Owners can edit an inventory item's unit from **Inventory**. Changing the unit updates its label but does not convert stock or recipe amounts, and clears its unit cost; enter a new purchase cost after changing units.
- POS items are grayed out when any configured recipe ingredient does not have enough stock. The server checks stock again when recording a sale.
- Owners can set or edit an inventory item's expiration date on **Inventory**. Stock of 50 units or less is critical (orange), stock above 50 and up to 100 units is low (yellow), and expired items or items expiring within 30 days are red. Cups do not require expiration dates.
- Expiration is tracked as one date per inventory item; restocking can update that tracked date.
- Sale, wastage, and save actions submit directly without browser confirmation pop-ups.

## Demand forecast

- Owners and baristas can open **Forecast** to view projected ingredient run-out dates and likely top-selling cup products for the current week and month. Cup usage averages display as whole numbers; the month stock-runs-out column is omitted.
- Ingredient projections use the Cumulative Demand Run-Out method: recorded ingredient consumption is averaged across up to the last 30 calendar days, including days with no sales, then compared with current stock. Recipe consumption must have been recorded for an ingredient to produce a run-out estimate.
- Product projections add current-period sales through yesterday to the recent average daily sales multiplied by the number of days remaining in the week or month. Add-ons are excluded.
- Forecasts are estimates based on recorded history, not guarantees. New or changed recipes, missing recipe entries, or changed incompatible units can reduce the available history or prevent a stock estimate.