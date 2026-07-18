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

  it('does not mislabel an unsupported ISO currency as EUR', () => {
    expect(currencySymbol('SEK')).not.toBe('€')
    expect(currencySymbol('SEK')).toBe('SEK')
  })

  it('falls back to the raw uppercased code for an invalid currency', () => {
    expect(currencySymbol('ZZZ')).toBe('ZZZ')
    expect(currencySymbol('zzz')).toBe('ZZZ')
  })
})
