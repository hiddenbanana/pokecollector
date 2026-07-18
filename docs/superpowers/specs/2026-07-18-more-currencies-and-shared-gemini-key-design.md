# Design: More currencies + shared Gemini key

Date: 2026-07-18

Two independent features, delivered together:

1. Support more display currencies beyond USD/EUR.
2. Make one admin-set Gemini API key usable by all users.

---

## Feature 1 — More display currencies

### Goal

Let users pick a display currency from `EUR, USD, GBP, JPY, CAD, AUD, CHF`
(adds GBP, JPY, CAD, AUD, CHF to the existing EUR/USD).

### Constraints / existing model (do not change)

- Prices are stored **natively**: Cardmarket values in EUR, TCGPlayer values in
  USD. The `currency` user setting is display-only; all conversion happens at
  render time. **No stored values are migrated.**
- Live rates come from the Frankfurter API via `GET /api/settings/exchange-rate`.
  Frankfurter already supports all 7 target currencies, so the endpoint itself
  needs no change.
- `currency` is already a per-user setting (`PER_USER_KEYS`), so multi-user
  instances already isolate it per user.

### Approach

Approach A: generalize the existing runtime-conversion model. Rejected
alternatives: a full currency-abstraction layer that normalizes stored money to
one base (over-engineered — nothing to migrate), and a frontend-only change
(backend `exchange-rate` returns 422 for unsupported currencies and
export/telegram format money server-side, so they would break).

### Currency metadata — single source of truth per side

A currency table listing the 7 codes with `symbol` and `decimals`
(JPY → 0 decimals, all others → 2). One table on the backend
(`services/exchange_rates.py`), one on the frontend. The frontend prefers
`Intl.NumberFormat` for display; the table is used for the dropdown and for the
few call-sites that need a bare symbol.

### Backend changes

**`services/exchange_rates.py`**
- Expand `SUPPORTED_CURRENCIES` to the 7 codes.
- Add `CURRENCIES` metadata (code → symbol, decimals).
- Replace the two-pair `FALLBACK_RATES` dict with an EUR-based approximate-rate
  table and triangulate any pair through EUR, so `fallback_exchange_rate(from, to)`
  never `KeyError`s when Frankfurter is unreachable. Approximate rates are for
  offline fallback only and are commented as such.
- `normalize_currency_pair` and `parse_frankfurter_v2_rate` unchanged.

**`api/settings.py`** — `/exchange-rate` endpoint unchanged (already proxies
Frankfurter and validates via `normalize_currency_pair`, which now accepts the
wider set).

**`api/export.py`** — replace the local `_normalize_currency` EUR/USD symbol map
and the `_convert_eur` `if currency == "USD"` branch with the shared currency
table: convert for any non-EUR currency (`amount * exchange_rate`, where
`exchange_rate` is the EUR→selected rate the frontend already passes) and format
with per-currency decimals.

**`services/telegram.py`** — generalize `_format_user_eur`: for any non-EUR
user currency, fetch EUR→currency and format with the currency's symbol and
decimals via the shared table (instead of the hardcoded EUR/USD branch).

### Frontend changes

**`contexts/SettingsContext.jsx` (core change)**
- Generalize the exchange-rate effect to fetch two rates for the selected
  currency X:
  - **EUR→X** → `exchangeRate` (applied to EUR-native amounts and to
    purchase-price input round-tripping).
  - **USD→X** → rename `usdToEurRate` to `usdToCurrencyRate` (applied to
    TCGPlayer USD-native amounts).
  - Each short-circuits to `1.0` when X equals the source currency.
- Track which currency the current `exchangeRate` belongs to so the
  `exchangeRateReady` / `moneyExchangeRateReady` gate generalizes (money is not
  shown with a stale rate before the fetch resolves). Ready when
  `X === 'EUR'` or the fetched rate's currency matches X.
- `formatPrice(eurAmount)` and `formatUsdPrice(usdAmount)` format the converted
  amount with `Intl.NumberFormat(locale, { style: 'currency', currency: X })`.
- Derive `currencySymbol` from `Intl.NumberFormat().formatToParts` (or the
  shared table) for the call-sites that use it directly (e.g. money-input
  prefixes).

**`pages/Settings.jsx`**
- Build the currency dropdown from the shared currency list instead of the
  hardcoded `EUR`/`USD` options.
- Reuse the same symbol source for the supporters `CURRENCY_SYMBOLS` map.

**`utils/moneyInput.js`** — unchanged (operates on raw numbers via
`exchangeRate`). Confirm JPY input (0 decimals) round-trips sensibly.

### Testing

- Backend: extend `backend/tests` with unit tests for `fallback_exchange_rate`
  triangulation across the new pairs and `normalize_currency_pair` over the
  wider set.
- Frontend: a Vitest test for the currency formatting helper (symbol, decimals,
  JPY zero-decimals).
- Manual: switch currency in Settings; verify card prices, purchase-price input
  round-trip, CSV export, and a Telegram price alert render correctly.

---

## Feature 2 — Shared Gemini API key (global with per-user override)

### Goal

An admin sets one Gemini API key that all users can use for card recognition,
while any user may still set a personal key that overrides the global one for
themselves.

### Current model

- `gemini_api_key` is a **per-user** setting (`PER_USER_KEYS` in `settings.py`;
  seeded per-user for admin in `database.py` migration).
- `get_gemini_key(db, user_id)` reads **only** the requesting user's key, with
  the comment "No global/env fallback — each user must configure their own key".
- The `GEMINI_API_KEY` env var is surfaced into the **admin's personal** key
  (settings display + migration seed).

### Approach

Add a separate admin-only global key rather than overloading the per-user key
name (which routes exclusively through per-user vs admin-only logic in
`settings.py`). This avoids a key-name routing collision.

### Backend changes

**`api/settings.py`**
- Add a new key `global_gemini_api_key` to `ADMIN_ONLY_KEYS`, with an empty
  default in `DEFAULT_SETTINGS`.
- Keep `gemini_api_key` in `PER_USER_KEYS` unchanged (the per-user override).

**`api/recognize.py`** — `get_gemini_key(db, user_id)` resolution order:
1. the user's own `gemini_api_key` (per-user);
2. else the global `global_gemini_api_key` (admin-set);
3. else `""`.
Update the docstring accordingly.

**Env var** — leave the existing `GEMINI_API_KEY` → admin-personal seeding
untouched (non-breaking). Per the chosen (non-env) option, the env var does
**not** auto-populate the new global key; the admin sets it in the global field.
(Open item flagged below in case the owner prefers env→global too.)

### Frontend changes

**`pages/Settings.jsx`** — add an admin-only "Shared Gemini API key" field bound
to `global_gemini_api_key` (rendered only for admins, like other
`ADMIN_ONLY_KEYS`). The existing personal Gemini field remains for every user as
the override. The raw global value is not exposed for editing to non-admins;
they simply benefit from it during recognition.

### Testing

- Backend: unit test `get_gemini_key` resolution — user key wins; global used
  when user key empty; `""` when neither set.
- Manual: as admin set the global key; as a non-admin user with no personal key,
  scan a card and confirm recognition succeeds; set a personal key and confirm
  it overrides.

---

## Open items / flags

- **Env→global Gemini key:** current design does not feed `GEMINI_API_KEY` env
  into the new global key. If the owner wants an env-configured instance to work
  for all users without re-entering the key in the UI, extend `get_gemini_key`
  step 2 to fall back to the env var.
- **Intl formatting of EUR/USD:** switching to `Intl.NumberFormat` may slightly
  change grouping/symbol placement for EUR/USD versus the current
  `symbol + toFixed(2)`. Accepted as part of correct localization.
