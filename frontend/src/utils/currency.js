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
  const upper = String(code || '').toUpperCase()
  try {
    const parts = new Intl.NumberFormat('en', { style: 'currency', currency: upper }).formatToParts(0)
    const part = parts.find(p => p.type === 'currency')
    if (part) return part.value
  } catch {
    // fall through - invalid/unrecognized code
  }
  const entry = CURRENCIES.find(c => c.code === upper)
  return entry ? entry.symbol : upper
}
