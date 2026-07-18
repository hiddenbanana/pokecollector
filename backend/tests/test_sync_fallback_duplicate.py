import unittest

try:
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from database import Base
    from models import Card, Set, Setting
    from services.card_fallbacks import build_missing_language_cards_for_set
    from services.card_upsert import upsert_card
    DEPS = True
except ModuleNotFoundError:
    DEPS = False


@unittest.skipUnless(DEPS, "SQLAlchemy not installed in this lightweight test environment")
class SyncFallbackDuplicateTests(unittest.TestCase):
    """Regression for the full-sync duplicate-PK crash on cards like basep-2_fr.

    perform_full_sync adds native cards then, when a set's native card count is
    below its total, runs the cross-language fallback. Production sessions use
    autoflush=False, so the fallback's "already exists" query cannot see the
    native cards added earlier in the same uncommitted transaction unless they
    are flushed first. Without that flush the fallback re-clones a card that was
    just added natively, and the two pending INSERTs collide at commit
    (UniqueViolation: Key (id)=(basep-2_fr) already exists).
    """

    def _session(self):
        # autoflush=False mirrors the production SessionLocal in database.py.
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        db = sessionmaker(bind=engine, autoflush=False)()
        db.add_all([
            Setting(key="cross_language_price_fallback", value="true"),
            Setting(key="cross_language_image_fallback", value="true"),
            Set(id="basep_en", tcg_set_id="basep", name="Wizards Black Star Promos", lang="en", total=53),
            Set(id="basep_fr", tcg_set_id="basep", name="Wizards Black Star Promos", lang="fr", total=53),
            # English sibling source card (committed) the fallback clones from.
            Card(
                id="basep-2_en", tcg_card_id="basep-2", name="Electabuzz",
                set_id="basep", number="2", lang="en",
                images_small="https://en/s.webp", images_large="https://en/l.webp",
                price_trend=1.0,
            ),
        ])
        db.commit()
        return db

    def _native_fr_card(self):
        return {
            "id": "basep-2_fr", "tcg_card_id": "basep-2", "name": "Électabuzz",
            "set_id": "basep", "number": "2", "lang": "fr",
            "images_small": "https://fr/s.webp", "images_large": "https://fr/l.webp",
        }

    def test_fallback_reclones_native_when_not_flushed(self):
        """Documents the bug: without a flush the fallback re-produces basep-2_fr."""
        db = self._session()
        upsert_card(db, self._native_fr_card())  # pending, not flushed
        clones = build_missing_language_cards_for_set(db, "basep", "fr", expected_total=1)
        self.assertTrue(
            any(c["id"] == "basep-2_fr" for c in clones),
            "expected the fallback to re-clone the un-flushed native card (the bug)",
        )

    def test_flush_before_fallback_prevents_duplicate_and_preserves_native(self):
        """The fix: flushing native cards first makes the fallback skip them."""
        db = self._session()
        upsert_card(db, self._native_fr_card())
        db.flush()  # the fix applied in perform_full_sync
        clones = build_missing_language_cards_for_set(db, "basep", "fr", expected_total=1)
        for parsed in clones:
            upsert_card(db, parsed)
        db.commit()  # must NOT raise IntegrityError

        rows = db.query(Card).filter(Card.id == "basep-2_fr").all()
        self.assertEqual(len(rows), 1)
        # Native French data preserved, not overwritten by the English fallback.
        self.assertIsNone(rows[0].data_source_lang)
        self.assertEqual(rows[0].name, "Électabuzz")


if __name__ == "__main__":
    unittest.main()
