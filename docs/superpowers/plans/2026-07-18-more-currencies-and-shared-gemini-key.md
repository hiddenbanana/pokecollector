# More Currencies + Shared Gemini Key Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add GBP, JPY, CAD, AUD, CHF as display currencies (alongside EUR/USD) and let one admin-set Gemini API key serve all users while any user can override with a personal key.

**Architecture:** Prices stay stored natively (Cardmarket EUR, TCGPlayer USD); display currency conversion stays runtime-only. A shared currency table (one per side) drives symbols/decimals; `Intl.NumberFormat` formats on the frontend. The Gemini key gains a separate admin-only global setting that `get_gemini_key` falls back to after the per-user key.

**Tech Stack:** FastAPI + SQLAlchemy (backend), React + Vite/Vitest (frontend), Frankfurter API for live rates, Python `unittest` for backend tests.

## Global Constraints

- Currency set is exactly: `EUR, USD, GBP, JPY, CAD, AUD, CHF`.
- JPY has 0 decimal places; all other currencies have 2.
- No stored monetary values are migrated — conversion is display-time only.
- Backend tests run in a container (host Node is v18; Vitest needs Node 20+):
  - Backend: `docker exec pokemon-backend python -m pytest backend/tests/<file> -v` (or `python -m unittest`).
  - Frontend: `docker run --rm -v "$PWD/frontend":/app -w /app node:20 npm test` (node:20, NOT alpine).
- The env var `GEMINI_API_KEY` → admin **personal** key seeding stays untouched; it does NOT feed the new global key.
- Frankfurter (`https://api.frankfurter.dev/v2/rate/{from}/{to}`) already supports all 7 currencies; the `/exchange-rate` endpoint needs no new fetch logic.
- Commit after each task. Do not push or open PRs.

---

### Task 1: Backend currency table + generalized fallback rates

**Files:**
- Modify: `backend/services/exchange_rates.py:1-40`
- Test: `backend/tests/test_exchange_rates.py`

**Interfaces:**
- Produces:
  - `SUPPORTED_CURRENCIES: set[str]` = `{"EUR","USD","GBP","JPY","CAD","AUD","CHF"}`
  - `CURRENCIES: dict[str, dict]` — `{"EUR": {"symbol": "€", "decimals": 2}, ...}`
  - `currency_decimals(code: str) -> int` (default 2)
  - `currency_symbol(code: str) -> str` (default the code itself)
  - `fallback_exchange_rate(from_currency: str, to_currency: str) -> float` — triangulates through EUR; never raises for a supported pair.
  - Unchanged: `normalize_currency_pair`, `parse_frankfurter_v2_rate`, `ExchangeRateError`.

- [ ] **Step 1: Update the existing failing test for the wider currency set**

In `backend/tests/test_exchange_rates.py`, replace the `test_rejects_unsupported_currency_pair` body (currently uses `("EUR","GBP")`, which is now supported) and add coverage for new pairs. Replace lines 15-22 with:

```python
    def test_rejects_unsupported_currency_pair(self):
        with self.assertRaises(ExchangeRateError):
            normalize_currency_pair("EUR", "SEK")

    def test_accepts_newly_supported_currencies(self):
        self.assertEqual(normalize_currency_pair(" gbp ", "jpy"), ("GBP", "JPY"))
        self.assertEqual(normalize_currency_pair("chf", "aud"), ("CHF", "AUD"))

    def test_fallback_rates_are_available_for_supported_pairs(self):
        self.assertEqual(fallback_exchange_rate("EUR", "EUR"), 1.0)
        self.assertEqual(fallback_exchange_rate("EUR", "USD"), 1.1)
        # Triangulated through EUR; USD->EUR is the inverse of EUR->USD.
        self.assertAlmostEqual(fallback_exchange_rate("USD", "EUR"), 1 / 1.1)
        # Any supported pair resolves without raising.
        for src in ("EUR", "USD", "GBP", "JPY", "CAD", "AUD", "CHF"):
            for dst in ("EUR", "USD", "GBP", "JPY", "CAD", "AUD", "CHF"):
                self.assertGreater(fallback_exchange_rate(src, dst), 0)

    def test_currency_metadata_decimals(self):
        self.assertEqual(currency_decimals("JPY"), 0)
        self.assertEqual(currency_decimals("EUR"), 2)
        self.assertEqual(currency_symbol("GBP"), "£")
```

Add `currency_decimals` and `currency_symbol` to the import block at the top (lines 3-8):

```python
from services.exchange_rates import (
    ExchangeRateError,
    currency_decimals,
    currency_symbol,
    fallback_exchange_rate,
    normalize_currency_pair,
    parse_frankfurter_v2_rate,
)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `docker exec pokemon-backend python -m pytest backend/tests/test_exchange_rates.py -v`
Expected: FAIL — `ImportError: cannot import name 'currency_decimals'` (and the USD/EUR triangulation assertion).

- [ ] **Step 3: Rewrite the top of `exchange_rates.py`**

Replace lines 1-25 (the `SUPPORTED_CURRENCIES`/`FALLBACK_RATES`/`normalize_currency_pair`/`fallback_exchange_rate` block) with:

```python
from decimal import Decimal, InvalidOperation

# Display currencies. Prices are stored natively in EUR (Cardmarket) and USD
# (TCGPlayer); everything else is a runtime conversion target.
CURRENCIES = {
    "EUR": {"symbol": "€", "decimals": 2},
    "USD": {"symbol": "$", "decimals": 2},
    "GBP": {"symbol": "£", "decimals": 2},
    "JPY": {"symbol": "¥", "decimals": 0},
    "CAD": {"symbol": "CA$", "decimals": 2},
    "AUD": {"symbol": "A$", "decimals": 2},
    "CHF": {"symbol": "CHF", "decimals": 2},
}
SUPPORTED_CURRENCIES = set(CURRENCIES)

# Approximate EUR-based rates used ONLY when the Frankfurter API is unreachable.
# These drift over time; live rates always win. Value = units of currency per 1 EUR.
_APPROX_EUR_RATES = {
    "EUR": 1.0,
    "USD": 1.1,
    "GBP": 0.85,
    "JPY": 160.0,
    "CAD": 1.5,
    "AUD": 1.65,
    "CHF": 0.95,
}


class ExchangeRateError(ValueError):
    pass


def currency_decimals(code: str | None) -> int:
    return CURRENCIES.get((code or "").upper(), {}).get("decimals", 2)


def currency_symbol(code: str | None) -> str:
    code = (code or "").upper()
    return CURRENCIES.get(code, {}).get("symbol", code)


def normalize_currency_pair(from_currency: str | None, to_currency: str | None) -> tuple[str, str]:
    source = (from_currency or "").strip().upper()
    target = (to_currency or "").strip().upper()
    if source not in SUPPORTED_CURRENCIES or target not in SUPPORTED_CURRENCIES:
        raise ExchangeRateError("unsupported currency pair")
    return source, target


def fallback_exchange_rate(from_currency: str, to_currency: str) -> float:
    """Offline approximation of from->to, triangulated through EUR."""
    if from_currency == to_currency:
        return 1.0
    src = _APPROX_EUR_RATES[from_currency]
    dst = _APPROX_EUR_RATES[to_currency]
    return dst / src
```

Leave `_parse_positive_rate` and `parse_frankfurter_v2_rate` (old lines 28-39) unchanged below this block.

- [ ] **Step 4: Run tests to verify they pass**

Run: `docker exec pokemon-backend python -m pytest backend/tests/test_exchange_rates.py -v`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add backend/services/exchange_rates.py backend/tests/test_exchange_rates.py
git commit -m "feat: support GBP/JPY/CAD/AUD/CHF in exchange rate service

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Backend export uses the currency table

**Files:**
- Modify: `backend/api/export.py:16-32`
- Test: `backend/tests/test_export_currency.py` (create)

**Interfaces:**
- Consumes: `CURRENCIES`, `currency_symbol`, `currency_decimals`, `SUPPORTED_CURRENCIES` from Task 1.
- Produces (module-local): `_normalize_currency(value) -> tuple[str, str]`, `_convert_eur(amount, exchange_rate, currency) -> float | None`, `_format_money(amount, currency) -> str` (note: `_format_money` now takes the currency code, not a symbol).

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_export_currency.py`:

```python
import unittest

try:
    from api.export import _normalize_currency, _convert_eur, _format_money
    DEPS = True
except ModuleNotFoundError:
    DEPS = False


@unittest.skipUnless(DEPS, "FastAPI not installed in lightweight env")
class ExportCurrencyTests(unittest.TestCase):
    def test_normalize_known_currency(self):
        self.assertEqual(_normalize_currency("gbp"), ("GBP", "£"))
        self.assertEqual(_normalize_currency("jpy"), ("JPY", "¥"))

    def test_normalize_unknown_defaults_to_eur(self):
        self.assertEqual(_normalize_currency("xxx"), ("EUR", "€"))

    def test_convert_eur_scales_for_non_eur(self):
        self.assertAlmostEqual(_convert_eur(10.0, 1.1, "USD"), 11.0)
        self.assertAlmostEqual(_convert_eur(10.0, 160.0, "JPY"), 1600.0)

    def test_convert_eur_no_scale_for_eur(self):
        self.assertEqual(_convert_eur(10.0, 1.0, "EUR"), 10.0)
        self.assertIsNone(_convert_eur(None, 1.1, "USD"))

    def test_format_money_respects_decimals(self):
        self.assertEqual(_format_money(1600.4, "JPY"), "¥1600")
        self.assertEqual(_format_money(11.0, "USD"), "$11.00")
        self.assertEqual(_format_money(None, "EUR"), "-")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker exec pokemon-backend python -m pytest backend/tests/test_export_currency.py -v`
Expected: FAIL — `_format_money` signature mismatch / JPY formatting wrong.

- [ ] **Step 3: Rewrite the helpers in `export.py`**

Add to the imports near the top (after the existing `from services...` lines, around line 6):

```python
from services.exchange_rates import SUPPORTED_CURRENCIES, currency_symbol, currency_decimals
```

Replace lines 16-32 (`_normalize_currency`, `_convert_eur`, `_format_money`) with:

```python
def _normalize_currency(value: str | None) -> tuple[str, str]:
    currency = (value or "EUR").upper()
    if currency not in SUPPORTED_CURRENCIES:
        currency = "EUR"
    return currency, currency_symbol(currency)


def _convert_eur(amount: float | None, exchange_rate: float, currency: str) -> float | None:
    if amount is None:
        return None
    return float(amount) * exchange_rate if currency != "EUR" else float(amount)


def _format_money(amount: float | None, currency: str) -> str:
    if amount is None:
        return "-"
    return f"{currency_symbol(currency)}{amount:.{currency_decimals(currency)}f}"
```

- [ ] **Step 4: Update `_format_money` call sites**

`_format_money` now takes the currency code, not the symbol. In `export.py`, find every `_format_money(<x>, symbol)` call (in `export_csv` and `export_pdf`) and change the second argument from `symbol` to `currency`. Run to locate them:

```bash
grep -n "_format_money(" backend/api/export.py
```

Change each `symbol` argument to `currency`. (The `symbol` local is still used in CSV/PDF headers via f-strings elsewhere — leave those.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `docker exec pokemon-backend python -m pytest backend/tests/test_export_currency.py -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/api/export.py backend/tests/test_export_currency.py
git commit -m "feat: generalize CSV/PDF export currency formatting

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Backend telegram price alert currency

**Files:**
- Modify: `backend/services/telegram.py:79-101`
- Test: `backend/tests/test_telegram_currency.py` (create)

**Interfaces:**
- Consumes: `currency_symbol`, `currency_decimals`, `fallback_exchange_rate` from Task 1.
- Produces (module-local, refactored): `_format_user_amount(amount, currency, rate) -> str` (pure, testable); `_format_user_eur(amount, db, user_id)` keeps its signature but delegates.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_telegram_currency.py`:

```python
import unittest

try:
    from services.telegram import _format_user_amount
    DEPS = True
except (ModuleNotFoundError, ImportError):
    DEPS = False


@unittest.skipUnless(DEPS, "httpx not installed in lightweight env")
class TelegramCurrencyTests(unittest.TestCase):
    def test_eur_no_conversion(self):
        self.assertEqual(_format_user_amount(10.0, "EUR", 1.0), "€10.00")

    def test_usd_conversion(self):
        self.assertEqual(_format_user_amount(10.0, "USD", 1.1), "$11.00")

    def test_jpy_zero_decimals(self):
        self.assertEqual(_format_user_amount(10.0, "JPY", 160.0), "¥1600")

    def test_none_amount(self):
        self.assertEqual(_format_user_amount(None, "GBP", 0.85), "£0.00")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker exec pokemon-backend python -m pytest backend/tests/test_telegram_currency.py -v`
Expected: FAIL — `cannot import name '_format_user_amount'`.

- [ ] **Step 3: Refactor `telegram.py`**

Add to imports (near the existing `from services.exchange_rates import parse_frankfurter_v2_rate`):

```python
from services.exchange_rates import (
    parse_frankfurter_v2_rate,
    fallback_exchange_rate,
    currency_symbol,
    currency_decimals,
)
```

Replace `_format_user_eur` (lines 79-101) with:

```python
def _format_user_amount(amount: float | None, currency: str, rate: float) -> str:
    """Format an EUR-denominated amount into the user's currency string."""
    converted = (amount or 0) * rate
    return f"{currency_symbol(currency)}{converted:.{currency_decimals(currency)}f}"


def _user_currency(db=None, user_id=None) -> str:
    currency = "EUR"
    if db is not None and user_id is not None:
        try:
            from models import UserSetting
            row = db.query(UserSetting).filter(
                UserSetting.user_id == user_id,
                UserSetting.key == "currency",
            ).first()
            currency = (row.value if row and row.value else "EUR").upper()
        except Exception:
            currency = "EUR"
    from services.exchange_rates import SUPPORTED_CURRENCIES
    return currency if currency in SUPPORTED_CURRENCIES else "EUR"


def _format_user_eur(amount: float, db=None, user_id=None) -> str:
    currency = _user_currency(db, user_id)
    if currency == "EUR":
        return _format_user_amount(amount, "EUR", 1.0)
    try:
        with httpx.Client(timeout=5.0) as client:
            response = client.get(f"https://api.frankfurter.dev/v2/rate/EUR/{currency}")
            response.raise_for_status()
            rate = parse_frankfurter_v2_rate(response.json())
    except Exception:
        rate = fallback_exchange_rate("EUR", currency)
    return _format_user_amount(amount, currency, rate)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `docker exec pokemon-backend python -m pytest backend/tests/test_telegram_currency.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/services/telegram.py backend/tests/test_telegram_currency.py
git commit -m "feat: generalize telegram price alert currency

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Frontend currency utility (metadata + Intl formatting)

**Files:**
- Create: `frontend/src/utils/currency.js`
- Test: `frontend/src/utils/currency.test.js`

**Interfaces:**
- Produces:
  - `CURRENCIES: Array<{ code, symbol, decimals }>` in dropdown order (EUR, USD, GBP, JPY, CAD, AUD, CHF).
  - `formatCurrency(amount: number, code: string): string` — uses `Intl.NumberFormat('en', { style:'currency', currency: code })`; returns `'-'` for null/NaN.
  - `currencySymbol(code: string): string` — derived from `Intl.NumberFormat(...).formatToParts`, fallback to code.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/utils/currency.test.js`:

```javascript
import { describe, it, expect } from 'vitest'
import { CURRENCIES, formatCurrency, currencySymbol } from './currency'

describe('currency utils', () => {
  it('lists the seven supported currencies in order', () => {
    expect(CURRENCIES.map(c => c.code)).toEqual(
      ['EUR', 'USD', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF']
    )
  })

  it('formats JPY with no decimals', () => {
    expect(formatCurrency(1234.5, 'JPY')).toBe('¥1,235')
  })

  it('formats USD with two decimals and $ symbol', () => {
    expect(formatCurrency(1234.5, 'USD')).toBe('$1,234.50')
  })

  it('returns dash for null/NaN', () => {
    expect(formatCurrency(null, 'EUR')).toBe('-')
    expect(formatCurrency(NaN, 'EUR')).toBe('-')
  })

  it('exposes a symbol per currency', () => {
    expect(currencySymbol('GBP')).toBe('£')
    expect(currencySymbol('EUR')).toBe('€')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker run --rm -v "$PWD/frontend":/app -w /app node:20 npm test -- currency`
Expected: FAIL — cannot resolve `./currency`.

- [ ] **Step 3: Implement `frontend/src/utils/currency.js`**

```javascript
// Single source of truth for display currencies on the frontend.
// Prices are stored natively in EUR/USD; these are conversion + display targets.
export const CURRENCIES = [
  { code: 'EUR', symbol: '€', decimals: 2 },
  { code: 'USD', symbol: '$', decimals: 2 },
  { code: 'GBP', symbol: '£', decimals: 2 },
  { code: 'JPY', symbol: '¥', decimals: 0 },
  { code: 'CAD', symbol: 'CA$', decimals: 2 },
  { code: 'AUD', symbol: 'A$', decimals: 2 },
  { code: 'CHF', symbol: 'CHF', decimals: 2 },
]

const CODES = new Set(CURRENCIES.map(c => c.code))

export function formatCurrency(amount, code) {
  if (amount == null || Number.isNaN(Number(amount))) return '-'
  const currency = CODES.has(code) ? code : 'EUR'
  return new Intl.NumberFormat('en', { style: 'currency', currency }).format(Number(amount))
}

export function currencySymbol(code) {
  const currency = CODES.has(code) ? code : 'EUR'
  try {
    const parts = new Intl.NumberFormat('en', { style: 'currency', currency }).formatToParts(0)
    const part = parts.find(p => p.type === 'currency')
    if (part) return part.value
  } catch {
    // fall through
  }
  const entry = CURRENCIES.find(c => c.code === currency)
  return entry ? entry.symbol : currency
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker run --rm -v "$PWD/frontend":/app -w /app node:20 npm test -- currency`
Expected: PASS.

Note: if `formatCurrency(1234.5, 'USD')` renders a non-breaking space or `US$`/`CA$` differs from the assertion under the container's ICU build, adjust the *test expectation* to the actual `Intl` output (do not hand-roll formatting) and re-run. The implementation is the source of truth; assertions match its real output.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/utils/currency.js frontend/src/utils/currency.test.js
git commit -m "feat: frontend currency metadata + Intl formatting util

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Generalize SettingsContext conversion for any currency

**Files:**
- Modify: `frontend/src/contexts/SettingsContext.jsx:95-98,136-178,248-264`

**Interfaces:**
- Consumes: `formatCurrency`, `currencySymbol` from Task 4.
- Produces (unchanged context API names): `formatPrice(eurAmount)`, `formatUsdPrice(usdAmount)`, `currency`, `currencySymbol`, `exchangeRate`, `exchangeRateReady`. Internally renames `usdToEurRate` → `usdToCurrencyRate`.

- [ ] **Step 1: Update rate state + fetch effect**

Replace the state declarations (lines 95-98):

```javascript
  const [exchangeRate, setExchangeRate] = useState(1.0)          // EUR -> selected
  const [exchangeRateReady, setExchangeRateReady] = useState(true)
  const [exchangeRateCurrency, setExchangeRateCurrency] = useState('EUR')
  const [usdToCurrencyRate, setUsdToCurrencyRate] = useState(1.0) // USD -> selected
```

Replace the entire rate-fetch effect (lines 136-178) with a currency-agnostic version:

```javascript
  // Fetch exchange rates through the backend to avoid browser CORS/redirect issues.
  // EUR-native amounts convert with EUR->selected; TCGPlayer USD amounts with USD->selected.
  useEffect(() => {
    const token = localStorage.getItem('token')
    if (authLoading || (multiUser && !token)) return

    const fetchExchangeRate = async (from, to, fallback) => {
      if (from === to) return 1.0
      try {
        const headers = token && multiUser ? { Authorization: `Bearer ${token}` } : {}
        const response = await fetch(`/api/settings/exchange-rate?from=${from}&to=${to}`, { headers })
        if (!response.ok) throw new Error('Exchange rate lookup failed')
        const data = await response.json()
        return Number(data.rate) || fallback
      } catch {
        return fallback
      }
    }

    const curr = settings.currency || 'EUR'
    let cancelled = false
    setExchangeRateReady(curr === 'EUR')
    setExchangeRateCurrency(curr === 'EUR' ? 'EUR' : null)
    setExchangeRate(curr === 'EUR' ? 1.0 : 1.0)

    Promise.all([
      fetchExchangeRate('EUR', curr, 1.0),
      fetchExchangeRate('USD', curr, 1.0),
    ]).then(([eurRate, usdRate]) => {
      if (cancelled) return
      setExchangeRate(eurRate)
      setUsdToCurrencyRate(usdRate)
      setExchangeRateCurrency(curr)
      setExchangeRateReady(true)
    })
    return () => { cancelled = true }
  }, [settings.currency, authLoading, multiUser, user?.id])
```

- [ ] **Step 2: Update derived values + formatters**

Replace lines 248-264 (`currency`, `currencySymbol`, `moneyExchangeRateReady`, `formatPrice`, `formatUsdPrice`) with:

```javascript
  const currency = settings.currency || 'EUR'
  const currencySym = currencySymbol(currency)
  const moneyExchangeRateReady = currency === 'EUR' || (exchangeRateReady && exchangeRateCurrency === currency)
  const pricePrimary = getPricePrimary()
  const pricePrimaryField = priceFieldFromPrimary(pricePrimary)

  const formatPrice = useCallback((eurAmount) => {
    if (eurAmount == null || isNaN(Number(eurAmount))) return '-'
    return formatCurrency(Number(eurAmount) * exchangeRate, currency)
  }, [exchangeRate, currency])

  const formatUsdPrice = useCallback((usdAmount) => {
    if (usdAmount == null || isNaN(Number(usdAmount))) return '-'
    return formatCurrency(Number(usdAmount) * usdToCurrencyRate, currency)
  }, [usdToCurrencyRate, currency])
```

Update the context provider `value` object (lines ~266-282): change `currencySymbol,` to `currencySymbol: currencySym,` (the exported key stays `currencySymbol`).

Add the import at the top of the file (with the other imports):

```javascript
import { formatCurrency, currencySymbol } from '../utils/currency'
```

- [ ] **Step 3: Build to verify no reference errors**

Run: `docker run --rm -v "$PWD/frontend":/app -w /app node:20 npm run build`
Expected: build succeeds. If it fails on a leftover `usdToEurRate` reference, run `grep -rn "usdToEurRate" src/` and rename remaining hits to `usdToCurrencyRate`.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/contexts/SettingsContext.jsx
git commit -m "feat: currency-agnostic price conversion in SettingsContext

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Currency dropdown + supporters symbols from shared list

**Files:**
- Modify: `frontend/src/pages/Settings.jsx:185-189,763-766`

**Interfaces:**
- Consumes: `CURRENCIES`, `currencySymbol` from Task 4.

- [ ] **Step 1: Replace the supporters symbol map**

Add near the top imports of `Settings.jsx`:

```javascript
import { CURRENCIES, currencySymbol as currencySymbolFor } from '../utils/currency'
```

Replace the `CURRENCY_SYMBOLS` object (lines 185-189) usage inside `formatSupporterAmount`: change `const symbol = CURRENCY_SYMBOLS[safeCurrency]` to `const symbol = currencySymbolFor(safeCurrency)`, and delete the now-unused `CURRENCY_SYMBOLS` const. (Supporters may report currencies outside our 7; `currencySymbolFor` falls back to the code, and the existing `${amount} ${currency}` branch still covers the null case.)

- [ ] **Step 2: Build the dropdown options from the shared list**

Replace the hardcoded options (lines 763-766) in the currency `SelectControl`:

```javascript
                  options={CURRENCIES.map(c => ({ value: c.code, label: `${c.symbol} ${c.code}` }))}
```

- [ ] **Step 3: Run frontend tests + build**

Run: `docker run --rm -v "$PWD/frontend":/app -w /app node:20 npm test`
Then: `docker run --rm -v "$PWD/frontend":/app -w /app node:20 npm run build`
Expected: tests PASS, build succeeds.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/Settings.jsx
git commit -m "feat: currency dropdown + supporter symbols from shared list

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Backend global Gemini key setting + resolution fallback

**Files:**
- Modify: `backend/api/settings.py:37-63`
- Modify: `backend/api/recognize.py:53-62`
- Test: `backend/tests/test_recognize.py`

**Interfaces:**
- Produces: `get_gemini_key(db, user_id)` resolution order — per-user `gemini_api_key` → global `global_gemini_api_key` (a `Setting` row) → `""`.
- New admin-only setting key: `global_gemini_api_key`.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_recognize.py` (uses an in-memory sqlite session mirroring the app models):

```python
@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "FastAPI/httpx are not installed")
class GeminiKeyResolutionTests(unittest.TestCase):
    def _session(self):
        from sqlalchemy import create_engine
        from sqlalchemy.orm import sessionmaker
        from models import Base
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        return sessionmaker(bind=engine)()

    def test_user_key_takes_priority(self):
        from api.recognize import get_gemini_key
        from models import UserSetting, Setting
        db = self._session()
        db.add(UserSetting(user_id=1, key="gemini_api_key", value="user-key"))
        db.add(Setting(key="global_gemini_api_key", value="global-key"))
        db.commit()
        self.assertEqual(get_gemini_key(db, 1), "user-key")

    def test_falls_back_to_global_key(self):
        from api.recognize import get_gemini_key
        from models import Setting
        db = self._session()
        db.add(Setting(key="global_gemini_api_key", value="global-key"))
        db.commit()
        self.assertEqual(get_gemini_key(db, 1), "global-key")

    def test_empty_when_neither_set(self):
        from api.recognize import get_gemini_key
        db = self._session()
        self.assertEqual(get_gemini_key(db, 1), "")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker exec pokemon-backend python -m pytest backend/tests/test_recognize.py::GeminiKeyResolutionTests -v`
Expected: FAIL — global fallback not implemented (`test_falls_back_to_global_key` returns `""`).

- [ ] **Step 3: Add the global key to settings routing**

In `backend/api/settings.py`, add `"global_gemini_api_key"` to `ADMIN_ONLY_KEYS` (lines 37-42):

```python
ADMIN_ONLY_KEYS = {
    "full_sync_interval_days", "price_sync_interval_minutes", "multi_user_mode",
    "tcgdex_sync_languages", "debug_mode",
    "cross_language_price_fallback", "cross_language_image_fallback",
    "global_gemini_api_key",
    DIGITAL_SETS_SETTING_KEY,
}
```

Add its default to `DEFAULT_SETTINGS` (after the `"debug_mode": "false",` line, ~line 62):

```python
    "global_gemini_api_key": "",
```

- [ ] **Step 4: Update `get_gemini_key` resolution**

In `backend/api/recognize.py`, replace `get_gemini_key` (lines 53-62). Ensure `Setting` is imported (it currently imports `UserSetting`; add `Setting`):

```python
def get_gemini_key(db: Session, user_id: int = None) -> str:
    """Read Gemini API key: per-user key first, then the admin global key."""
    if user_id is not None:
        row = db.query(UserSetting).filter(
            UserSetting.user_id == user_id, UserSetting.key == "gemini_api_key"
        ).first()
        if row and row.value:
            return row.value
    global_row = db.query(Setting).filter(Setting.key == "global_gemini_api_key").first()
    if global_row and global_row.value:
        return global_row.value
    return ""
```

At the top of `recognize.py`, confirm the models import includes `Setting`. Run `grep -n "from models import" backend/api/recognize.py`; if it is `from models import UserSetting`, change to `from models import UserSetting, Setting` (add `Setting` without dropping existing names).

- [ ] **Step 5: Run tests to verify they pass**

Run: `docker exec pokemon-backend python -m pytest backend/tests/test_recognize.py -v`
Expected: PASS (all classes).

- [ ] **Step 6: Commit**

```bash
git add backend/api/settings.py backend/api/recognize.py backend/tests/test_recognize.py
git commit -m "feat: admin global Gemini key with per-user override

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Frontend admin-only global Gemini key field

**Files:**
- Modify: `frontend/src/pages/Settings.jsx:310-311,344-346,401-402,788-817`
- Modify: `frontend/src/i18n/en.js:739-740`

**Interfaces:**
- Consumes: existing `getSetting`/`saveSetting` API client, `user?.role` from context.

- [ ] **Step 1: Add i18n strings**

In `frontend/src/i18n/en.js`, after line 740 (`geminiApiKeyDesc`), add:

```javascript
    globalGeminiApiKey: 'Shared Gemini API Key (all users)',
    globalGeminiApiKeyDesc: 'Used for card recognition by any user without their own key',
```

(Other locales fall back to English automatically via the `t()` helper.)

- [ ] **Step 2: Add global-key state + query**

In `Settings.jsx`, next to the existing gemini state (lines 310-311) add:

```javascript
  const [globalGeminiKey, setGlobalGeminiKey] = useState('')
  const [globalGeminiDirty, setGlobalGeminiDirty] = useState(false)
```

Next to the existing gemini query (lines 344-346) add:

```javascript
  const { data: globalGeminiKeyData } = useQuery({
    queryKey: ['setting', 'global_gemini_api_key'],
    queryFn: () => getSetting('global_gemini_api_key').catch(() => ({ value: '' })),
    enabled: user?.role === 'admin',
  })
```

Next to the existing sync effect (lines 401-402) add:

```javascript
    if (globalGeminiKeyData?.value !== undefined && !globalGeminiDirty) setGlobalGeminiKey(globalGeminiKeyData.value)
```

Extend that effect's dependency array to include `globalGeminiKeyData`.

- [ ] **Step 3: Render the admin-only field**

In the AI `SettingsCard`, change the existing personal-key `SettingsRow` (line 790) so it is no longer `last` (remove the `last` prop), then add a new admin-only row after it (after line 817 closing `</SettingsRow>`):

```jsx
              {user?.role === 'admin' && (
                <SettingsRow label={t('settings.globalGeminiApiKey')} description={t('settings.globalGeminiApiKeyDesc')} last>
                  <div className="flex items-center gap-2 w-full mt-2">
                    <input
                      type={globalGeminiDirty ? "text" : "password"}
                      value={globalGeminiKey}
                      onChange={e => { setGlobalGeminiKey(e.target.value); setGlobalGeminiDirty(true) }}
                      placeholder="AIza..."
                      className="input flex-1 text-xs font-mono"
                      style={{ minWidth: 0 }}
                    />
                    {globalGeminiKey && !globalGeminiDirty && (
                      <span className="text-xs text-green flex-shrink-0">✅</span>
                    )}
                    {globalGeminiDirty && (
                      <button
                        onClick={async () => {
                          await saveSetting('global_gemini_api_key', globalGeminiKey)
                          setGlobalGeminiDirty(false)
                          queryClient.invalidateQueries({ queryKey: ['setting', 'global_gemini_api_key'] })
                          toast.success(t('settings.apiKeySaved'))
                        }}
                        className="btn-primary-sm flex-shrink-0"
                      >
                        {t('common.save')}
                      </button>
                    )}
                  </div>
                </SettingsRow>
              )}
```

- [ ] **Step 4: Build to verify**

Run: `docker run --rm -v "$PWD/frontend":/app -w /app node:20 npm run build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/Settings.jsx frontend/src/i18n/en.js
git commit -m "feat: admin-only shared Gemini API key field in settings

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Run the whole backend test suite**

Run: `docker exec pokemon-backend python -m pytest backend/tests -v`
Expected: PASS (no regressions in the other 20 files).

- [ ] **Step 2: Run the whole frontend test suite + build**

Run: `docker run --rm -v "$PWD/frontend":/app -w /app node:20 npm test`
Then: `docker run --rm -v "$PWD/frontend":/app -w /app node:20 npm run build`
Expected: tests PASS, build succeeds.

- [ ] **Step 3: Manual smoke test (deploy is live — rebuild containers)**

Rebuild and restart per the repo's local compose (`.env` pins `COMPOSE_FILE=docker-compose.local.yml`):

```bash
docker compose up -d --build frontend backend
```

Then at https://poke.roberts-clan.site (hard-refresh, Ctrl+Shift+R, to escape the cacheable index.html):
- Settings → Currency: switch to JPY; confirm a card price shows as `¥` with no decimals; switch to GBP/CAD and confirm symbol + 2 decimals.
- Add a card with a purchase price in the selected currency; reopen and confirm the value round-trips.
- Settings → export CSV in a non-EUR currency; confirm the header and values use that currency.
- As admin, set the Shared Gemini API key; as a non-admin user with no personal key, scan a card and confirm recognition works; set a personal key and confirm it overrides.

- [ ] **Step 4: Final confirmation**

No commit (verification only). Report which manual checks passed with observed output.

---

## Self-Review notes

- **Spec coverage:** currency table (T1/T4), fallback triangulation (T1), export (T2), telegram (T3), SettingsContext EUR→X + USD→X (T5), Intl formatting (T4/T5), dropdown (T6), supporters symbols (T6), global Gemini key backend (T7), admin-only UI (T8), tests + manual (T1-T9). Env→global explicitly excluded per design.
- **Placeholders:** none — all steps carry real code/commands.
- **Type consistency:** `_format_money(amount, currency)` updated at all call sites (T2 Step 4); `usdToEurRate`→`usdToCurrencyRate` renamed with a grep sweep (T5); context export key stays `currencySymbol` (value `currencySym`); `get_gemini_key` signature unchanged.
