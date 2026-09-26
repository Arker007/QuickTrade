// @vitest-environment jsdom
// Symbol picker unit tests: favorites matching, canonical keys, filtering, and tab selection.
import { describe, it, expect, vi } from 'vitest';
import type { SymbolDescriptor } from '../src/core/ports/DataProvider';
import { SymbolPicker, canonicalSymbolKey, isSymbolInFavorites } from '../src/widget/symbol-picker';

const SAMPLE_SYMBOLS: SymbolDescriptor[] = [
    { ticker: 'BTCUSDT', type: 'crypto', prefix: 'binance', description: 'Bitcoin / Tether' },
    { ticker: 'ETHUSDT', type: 'crypto', prefix: 'binance', description: 'Ethereum / Tether' },
    { ticker: 'EURUSD', type: 'forex', prefix: 'binomo', description: 'Euro / US Dollar' },
    { ticker: 'GBPUSD', type: 'forex', prefix: 'binomo', description: 'British Pound / US Dollar' },
    { ticker: 'AAPL', type: 'stock', prefix: 'nasdaq', description: 'Apple Inc.' },
];

describe('symbol favorite helpers', () => {
    it('canonicalSymbolKey creates venue-prefixed or bare key', () => {
        expect(canonicalSymbolKey({ ticker: 'BTCUSDT', prefix: 'binance' })).toBe('binance:BTCUSDT');
        expect(canonicalSymbolKey({ ticker: 'ETHUSDT', provider: 'binance' })).toBe('binance:ETHUSDT');
        expect(canonicalSymbolKey({ ticker: 'AAPL' })).toBe('AAPL');
    });

    it('isSymbolInFavorites matches prefixed or bare ticker case-insensitively', () => {
        const favs = new Set(['BINANCE:BTCUSDT', 'EURUSD']);
        expect(isSymbolInFavorites({ ticker: 'BTCUSDT', prefix: 'binance' }, favs)).toBe(true);
        expect(isSymbolInFavorites({ ticker: 'EURUSD', prefix: 'binomo' }, favs)).toBe(true);
        expect(isSymbolInFavorites({ ticker: 'ETHUSDT', prefix: 'binance' }, favs)).toBe(false);
        expect(isSymbolInFavorites({ ticker: 'AAPL', prefix: 'nasdaq' }, favs)).toBe(false);
    });
});

describe('SymbolPicker favorites integration', () => {
    it('renders favorite stars and filters by Favorites tab', async () => {
        const host = document.createElement('div');
        document.body.appendChild(host);

        const onSelect = vi.fn();
        const onFavorite = vi.fn();

        const picker = new SymbolPicker({
            host,
            favorites: ['binance:BTCUSDT', 'binomo:EURUSD'],
            onSelect,
            onFavorite,
        });
        picker.setSource(() => SAMPLE_SYMBOLS);

        picker.open();
        await new Promise((r) => setTimeout(r, 50));

        const rows = host.querySelectorAll<HTMLElement>('.vela-sp-row');
        expect(rows.length).toBe(SAMPLE_SYMBOLS.length);

        // Check star elements
        const stars = host.querySelectorAll<HTMLElement>('.vela-sp-star');
        expect(stars.length).toBe(SAMPLE_SYMBOLS.length);

        // BTCUSDT is favorited
        const btcRow = [...rows].find((r) => r.dataset.ticker === 'BTCUSDT')!;
        const btcStar = btcRow.querySelector<HTMLElement>('.vela-sp-star')!;
        expect(btcStar.classList.contains('vela-fav')).toBe(true);
        expect(btcStar.getAttribute('aria-label')).toBe('Remove from favorites');

        // ETHUSDT is not favorited
        const ethRow = [...rows].find((r) => r.dataset.ticker === 'ETHUSDT')!;
        const ethStar = ethRow.querySelector<HTMLElement>('.vela-sp-star')!;
        expect(ethStar.classList.contains('vela-fav')).toBe(false);
        expect(ethStar.getAttribute('aria-label')).toBe('Add to favorites');

        // Clicking ethStar toggles favorite and fires onFavorite without triggering onSelect
        ethStar.click();
        expect(onFavorite).toHaveBeenCalledWith('binance:ETHUSDT', true);
        expect(onSelect).not.toHaveBeenCalled();
        expect(ethStar.classList.contains('vela-fav')).toBe(true);

        // Clicking Favorites tab shows only favorited items
        const favTab = [...host.querySelectorAll<HTMLElement>('.vela-sp-tab')].find(
            (t) => t.textContent?.includes('Favorites'),
        )!;
        expect(favTab).toBeDefined();
        favTab.click();

        const favRows = host.querySelectorAll<HTMLElement>('.vela-sp-row');
        expect(favRows.length).toBe(3); // BTCUSDT, EURUSD, and just added ETHUSDT

        // Toggling favorite off on BTC while in Favorites tab removes it from view
        const btcFavStar = [...favRows]
            .find((r) => r.dataset.ticker === 'BTCUSDT')!
            .querySelector<HTMLElement>('.vela-sp-star')!;
        btcFavStar.click();
        expect(onFavorite).toHaveBeenCalledWith('binance:BTCUSDT', false);

        const remainingFavRows = host.querySelectorAll<HTMLElement>('.vela-sp-row');
        expect(remainingFavRows.length).toBe(2);

        picker.destroy();
        host.remove();
    });
});
