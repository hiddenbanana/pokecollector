import unittest

try:
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from api.settings import _get_user_settings, _is_admin
    from database import Base
    from models import Setting, User

    SETTINGS_TEST_DEPS_AVAILABLE = True
except ModuleNotFoundError:
    SETTINGS_TEST_DEPS_AVAILABLE = False


@unittest.skipUnless(SETTINGS_TEST_DEPS_AVAILABLE, "Backend dependencies are not installed in this lightweight test environment")
class SensitiveAdminKeysTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)
        self.db = self.Session()

        self.admin = User(id=1, username="admin", hashed_password="x", role="admin", is_active=True)
        self.non_admin = User(id=2, username="trainer", hashed_password="x", role="trainer", is_active=True)
        self.db.add_all([self.admin, self.non_admin])
        self.db.add(Setting(key="global_gemini_api_key", value="AIza-SECRET"))
        self.db.add(Setting(key="full_sync_interval_days", value="7"))
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def test_non_admin_does_not_see_sensitive_admin_key(self):
        settings = _get_user_settings(self.db, self.non_admin.id)

        self.assertNotIn("global_gemini_api_key", settings)

    def test_admin_sees_sensitive_admin_key(self):
        settings = _get_user_settings(self.db, self.admin.id)

        self.assertIn("global_gemini_api_key", settings)
        self.assertEqual(settings["global_gemini_api_key"], "AIza-SECRET")

    def test_non_admin_still_sees_non_sensitive_admin_only_key(self):
        settings = _get_user_settings(self.db, self.non_admin.id)

        self.assertEqual(settings["full_sync_interval_days"], "7")
