# TENDIES whale tracker

Poseban alat, odvojen od DCA bota. **Samo čita lanac**: nema ključeva i ništa ne kupuje.

Svakog sata:
1. Čita sve Uniswap V3 swapove iz TENDIES poolova (WETH i USDG parovi).
2. Svaka kupovina od **$2.000 naviše** pravi „kita” od walleta koji je potpisao transakciju i stavlja ga na listu za praćenje.
3. Za svakog kita prati svako kretanje TENDIES-a: kupovine, prodaje i slanja drugim walletima. Ako kitovi šalju jedni drugima, označava ih kao povezane.
4. Sa Blockscout-a uzima profil walleta: broj transakcija, ETH i šta još drži. Osvežava ga jednom dnevno.
5. Objavljuje dashboard.

## Dashboard

https://nrr024.github.io/tendies-kitovi/

Prvi put skener prelazi 30 dana istorije u 2–3 runa, pa je sve na mestu za par sati. Dok sustiže, pored vremena stoji „sustiže istoriju”.

## Oznake (heuristika, ne presuda)

| Oznaka | Značenje |
|---|---|
| drži | prodao manje od 10%, prati se 7+ dana |
| akumulira | 3+ kupovine, prodao manje od 10% |
| flipper | prodao pola ili više u roku od 48h od prve kupovine |
| izlazi | prodao pola ili više pozicije |
| svež wallet | manje od 15 transakcija ukupno |
| bot? | više od 5.000 transakcija |
| povezan | slao ili primao TENDIES od drugog kita |

★ „moji” se čuvaju u tvom browseru.

## Podešavanja (`config.json`)

- `minUsd` — prag za kita (sada 2000)
- `backfillDays` — koliko unazad gleda pri prvom skenu
- Drugi token (npr. Juggernaut): kopiraj repo i promeni `token`.
