import { describe, it, expect } from 'vitest'
import { ownedBinderName, findOwnedBinderForSet } from './ownedBinder'

describe('ownedBinder helpers', () => {
  it('builds the auto name from the set name, falling back to the id', () => {
    expect(ownedBinderName('Scarlet & Violet', 'sv01_en')).toBe('Scarlet & Violet (owned)')
    expect(ownedBinderName('', 'sv01_en')).toBe('sv01_en (owned)')
    expect(ownedBinderName(null, 'sv01_en')).toBe('sv01_en (owned)')
  })

  it('reuses an existing collection binder with the same auto name', () => {
    const binders = [
      { id: 1, name: 'Other', binder_type: 'collection' },
      { id: 2, name: 'Scarlet & Violet (owned)', binder_type: 'collection' },
    ]
    expect(findOwnedBinderForSet(binders, 'Scarlet & Violet (owned)')?.id).toBe(2)
  })

  it('treats a missing binder_type as a collection binder', () => {
    const binders = [{ id: 5, name: 'X (owned)' }]
    expect(findOwnedBinderForSet(binders, 'X (owned)')?.id).toBe(5)
  })

  it('does not reuse a non-collection binder or a different name', () => {
    const binders = [
      { id: 3, name: 'Scarlet & Violet (owned)', binder_type: 'wishlist' },
      { id: 4, name: 'SV (owned)', binder_type: 'collection' },
    ]
    expect(findOwnedBinderForSet(binders, 'Scarlet & Violet (owned)')).toBeNull()
  })

  it('handles empty / undefined binder lists', () => {
    expect(findOwnedBinderForSet(undefined, 'x')).toBeNull()
    expect(findOwnedBinderForSet([], 'x')).toBeNull()
  })
})
