import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import en from '../i18n/en'
import { priceFieldFromPrimary } from '../utils/prices'
import { normalizeTcgdexLanguageCsv } from '../utils/tcgdexLanguages'
import { formatCurrency, currencySymbol } from '../utils/currency'
import { useAuth } from './AuthContext'

const TRANSLATION_LOADERS = {
  de: () => import('../i18n/de'),
  zh: () => import('../i18n/zh'),
  'zh-cn': () => import('../i18n/zhCn'),
  sv: () => import('../i18n/sv'),
  fr: () => import('../i18n/fr'),
  nl: () => import('../i18n/nl'),
  es: () => import('../i18n/es'),
  'es-mx': () => import('../i18n/esMx'),
  it: () => import('../i18n/it'),
  pt: () => import('../i18n/pt'),
  'pt-br': () => import('../i18n/ptBr'),
  'pt-pt': () => import('../i18n/ptPt'),
  pl: () => import('../i18n/pl'),
  ru: () => import('../i18n/ru'),
  ja: () => import('../i18n/ja'),
  ko: () => import('../i18n/ko'),
  id: () => import('../i18n/id'),
  th: () => import('../i18n/th'),
  'zh-tw': () => import('../i18n/zhTw'),
}
const SUPPORTED_LANGUAGES = new Set(['en', ...Object.keys(TRANSLATION_LOADERS)])

const DEFAULT_SETTINGS = {
  language: 'en',
  price_display: '["trend", "avg", "avg1", "avg7", "avg30", "low"]',
  price_primary: 'trend',
  tcgdex_sync_languages: 'en,de',
  tcgdex_digital_sets_enabled: 'true',
  cross_language_price_fallback: 'true',
  cross_language_image_fallback: 'true',
  set_overview_filters: '{}',
  hidden_set_ids: '[]',
  debug_mode: 'false',
  public_profiles_enabled: 'false',
}

const LANGUAGE_STORAGE_KEY = 'app_language'

// The backend stays the source of truth for the language, but it only answers after
// auth resolves. Mirroring the choice locally lets the first paint (and a failed or
// unauthenticated settings fetch) use the language the user actually picked.
function readCachedLanguage() {
  try {
    const cached = localStorage.getItem(LANGUAGE_STORAGE_KEY)
    return cached && SUPPORTED_LANGUAGES.has(cached) ? cached : null
  } catch {
    return null
  }
}

function cacheLanguage(language) {
  if (!language || !SUPPORTED_LANGUAGES.has(language)) return
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, language)
  } catch {
    // Storage can be unavailable (private mode, blocked cookies); the backend copy still holds.
  }
}

function initialSettings() {
  return { ...DEFAULT_SETTINGS, language: readCachedLanguage() || DEFAULT_SETTINGS.language }
}

const SettingsContext = createContext(null)

export function SettingsProvider({ children }) {
  const { user, loading: authLoading, multiUser } = useAuth()
  const [settings, setSettings] = useState(initialSettings)
  const [loaded, setLoaded] = useState(false)
  const [exchangeRate, setExchangeRate] = useState(1.0)          // EUR -> selected
  const [exchangeRateReady, setExchangeRateReady] = useState(true)
  const [exchangeRateCurrency, setExchangeRateCurrency] = useState('EUR')
  const [usdToCurrencyRate, setUsdToCurrencyRate] = useState(1.0) // USD -> selected
  const [loadedTranslations, setLoadedTranslations] = useState({ en })

  // Load settings from backend once auth mode is known. Single-user mode has no
  // token, but the backend still auto-authenticates the bootstrap admin.
  useEffect(() => {
    if (authLoading) return

    setLoaded(false)
    const token = localStorage.getItem('token')
    if (multiUser && !token) {
      setSettings(initialSettings())
      setLoaded(true)
      return
    }

    const headers = token && multiUser ? { Authorization: `Bearer ${token}` } : {}
    fetch('/api/settings/', { headers })
      .then(r => {
        if (!r.ok) throw new Error('Settings load failed')
        return r.json()
      })
      .then(data => {
        const language = data.language === 'zh' ? 'zh-cn' : data.language
        cacheLanguage(language)
        setSettings(prev => ({
          ...prev,
          ...data,
          language: language || prev.language,
          tcgdex_sync_languages: normalizeTcgdexLanguageCsv(data.tcgdex_sync_languages || prev.tcgdex_sync_languages),
        }))
        setLoaded(true)
      })
      .catch(() => {
        // Backend not available, use defaults
        setLoaded(true)
      })
  }, [authLoading, multiUser, user?.id])

  const lang = settings.language || DEFAULT_SETTINGS.language
  useEffect(() => {
    if (lang === 'en' || loadedTranslations[lang]) return
    const loader = TRANSLATION_LOADERS[lang]
    if (!loader) return

    let cancelled = false
    loader()
      .then(module => {
        if (!cancelled) {
          setLoadedTranslations(previous => ({ ...previous, [lang]: module.default }))
        }
      })
      .catch(() => {
        // English remains available if a language chunk cannot be loaded.
      })
    return () => { cancelled = true }
  }, [lang, loadedTranslations])

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

  // Update one or more settings
  const updateSettings = useCallback(async (updates) => {
    const next = { ...settings, ...updates }
    setSettings(next)
    try {
      const token = localStorage.getItem('token')
      const headers = { 'Content-Type': 'application/json' }
      if (token && multiUser) headers.Authorization = `Bearer ${token}`

      const resp = await fetch('/api/settings/', {
        method: 'PUT',
        headers,
        body: JSON.stringify(updates),
      })
      if (!resp.ok) throw new Error('Save failed')
      const saved = await resp.json()
      const language = saved.language === 'zh' ? 'zh-cn' : saved.language
      cacheLanguage(language)
      setSettings(prev => ({
        ...prev,
        ...saved,
        language: language || prev.language,
      }))
    } catch (err) {
      setSettings(settings)
      console.error('Failed to save settings:', err)
      throw err
    }
  }, [settings, multiUser])

  const msgs = loadedTranslations[lang] || en

  // Translation helper
  const t = useCallback((path) => {
    const parts = path.split('.')
    let val = msgs
    for (const part of parts) {
      val = val?.[part]
      if (val === undefined) break
    }
    if (val === undefined) {
      // Fallback to English
      let fallback = en
      for (const part of parts) {
        fallback = fallback?.[part]
        if (fallback === undefined) break
      }
      return fallback ?? path
    }
    return val
  }, [msgs])

  // Parse price_display JSON safely
  const getPriceDisplay = useCallback(() => {
    try {
      const val = settings.price_display
      if (Array.isArray(val)) return val
      return JSON.parse(val || '["trend", "avg", "avg1", "avg7", "avg30", "low"]')
    } catch {
      return ['trend', 'avg', 'avg1', 'avg7', 'avg30', 'low']
    }
  }, [settings.price_display])

  const getPricePrimary = useCallback(() => {
    return settings.price_primary || 'trend'
  }, [settings.price_primary])

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

  return (
    <SettingsContext.Provider value={{
      settings,
      updateSettings,
      t,
      language: lang,
      priceDisplay: getPriceDisplay(),
      pricePrimary,
      pricePrimaryField,
      loaded,
      currency,
      currencySymbol: currencySym,
      exchangeRate,
      exchangeRateReady: moneyExchangeRateReady,
      formatPrice,
      formatUsdPrice,
    }}>
      {children}
    </SettingsContext.Provider>
  )
}

export function useSettings() {
  const ctx = useContext(SettingsContext)
  if (!ctx) throw new Error('useSettings must be used within SettingsProvider')
  return ctx
}

export default SettingsContext
