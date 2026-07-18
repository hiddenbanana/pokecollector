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


def _parse_positive_rate(raw_rate) -> float:
    try:
        rate = Decimal(str(raw_rate))
    except (InvalidOperation, TypeError):
        raise ExchangeRateError("missing exchange rate") from None
    if not rate.is_finite() or rate <= 0:
        raise ExchangeRateError("invalid exchange rate")
    return float(rate)


def parse_frankfurter_v2_rate(payload: dict) -> float:
    return _parse_positive_rate(payload.get("rate"))
