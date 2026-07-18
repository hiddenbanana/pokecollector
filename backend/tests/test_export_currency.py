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
