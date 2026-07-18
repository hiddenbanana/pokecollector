import unittest

from services.exchange_rates import (
    ExchangeRateError,
    currency_decimals,
    currency_symbol,
    fallback_exchange_rate,
    normalize_currency_pair,
    parse_frankfurter_v2_rate,
)


class ExchangeRateTests(unittest.TestCase):
    def test_normalizes_supported_currency_pair(self):
        self.assertEqual(normalize_currency_pair(" eur ", "usd"), ("EUR", "USD"))

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

    def test_parses_frankfurter_v2_rate(self):
        self.assertEqual(parse_frankfurter_v2_rate({"rate": 0.92}), 0.92)

    def test_rejects_missing_or_invalid_frankfurter_v2_rate(self):
        for payload in (
            {},
            {"rate": 0},
            {"rate": "nope"},
            {"rate": "NaN"},
            {"rate": "Infinity"},
        ):
            with self.subTest(payload=payload):
                with self.assertRaises(ExchangeRateError):
                    parse_frankfurter_v2_rate(payload)


if __name__ == "__main__":
    unittest.main()
