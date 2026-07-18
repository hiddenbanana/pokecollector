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
