/*
 * Данные справочника моделей и поколений — версия 1 (черновик, 10.10.2026). Составлено по общеизвестным заводским индексам и годам выпуска;
 * Mikita и Claude проверяют 20–30 самых заметных моделей на сайте (решение 10.10), ошибки правим здесь.
 *
 * Запись: { make, families: [{ name, match, exclude?, gens: [{ id, label?, from, to, code?, when? }] }] }.
 *   match   — регулярка по нормализованному тексту (нижний регистр, без знаков, «560 SL» → «560 sl»);
 *   gens    — поколения: сначала шифр в названии (code), затем годы выпуска (from–to, включительно; when — условие по названию);
 *   порядок семейств внутри марки важен: сначала узкие («Mustang Mach-E»), потом широкие («Mustang»).
 */

// Короткая запись поколения.
const gen = (id, from, to, extra = {}) => ({ id, from, to, ...extra });
const G = (n, from, to, code) => gen(n, from, to, code ? { code } : {});

// Поколения пикапов Ford F-Series (общие для F-100/F-150/F-250/F-350).
const F_SERIES = [
  gen("1948–1952", 1948, 1952), gen("1953–1956", 1953, 1956), gen("1957–1960", 1957, 1960), gen("1961–1966", 1961, 1966),
  gen("1967–1972", 1967, 1972), gen("1973–1979", 1973, 1979), gen("1980–1986", 1980, 1986), gen("1987–1991", 1987, 1991),
  gen("1992–1996", 1992, 1996), gen("1997–2003", 1997, 2003), gen("2004–2008", 2004, 2008), gen("2009–2014", 2009, 2014),
  gen("2015–2020", 2015, 2020), gen("2021–", 2021, 2035),
];

const DIRECTORY = [
  {
    make: "Porsche",
    families: [
      { name: "Cayenne", match: /cayenne/, gens: [G("955/957", 2003, 2010), G("958", 2011, 2018, /\b958\b/), G("9YA", 2019, 2035, /\b9ya\b/)] },
      { name: "Panamera", match: /panamera/, gens: [G("970", 2010, 2016, /\b970\b/), G("971", 2017, 2035, /\b971\b/)] },
      { name: "Macan", match: /macan/ },
      { name: "Taycan", match: /taycan/ },
      { name: "Carrera GT", match: /carrera gt\b/ },
      { name: "918 Spyder", match: /\b918\b/ },
      { name: "959", match: /\b959\b/ },
      { name: "Boxster", match: /boxster|718 spyder/, gens: [G("986", 1997, 2004, /\b986\b/), G("987", 2005, 2012, /\b987\b/), G("981", 2013, 2016, /\b981\b/), G("982", 2017, 2035, /\b(982|718)\b/)] },
      { name: "Cayman", match: /cayman|\bgt4\b/, gens: [G("987", 2006, 2012, /\b987\b/), G("981", 2013, 2016, /\b981\b/), G("982", 2017, 2035, /\b(982|718)\b/)] },
      { name: "356", match: /\b356/, gens: [G("Pre-A", 1948, 1955, /\bpre-?a\b/), G("A", 1956, 1959, /\b356 ?a\b/), G("B", 1960, 1963, /\b356 ?b\b/), G("C", 1964, 1965, /\b356 ?c\b/)] },
      { name: "912", match: /\b912/ },
      { name: "914", match: /\b914/ },
      { name: "924", match: /\b924/ },
      { name: "928", match: /\b928/ },
      { name: "944", match: /\b944/ },
      { name: "968", match: /\b968/ },
      {
        name: "911",
        match: /\b(911|930|964|993|996|997|991|992)/,
        gens: [
          G("G-серия (1974–1989)", 1974, 1989, /\b(930|3\.2|g-?series|911 ?sc)\b/), G("964", 1989, 1993, /\b964\b/), G("993", 1994, 1998, /\b993\b/), G("996.1", 1999, 2001, /\b996\.1\b/), G("996.2", 2002, 2004, /\b996\.2\b/),
          G("997.1", 2005, 2008, /\b997\.1\b/), G("997.2", 2009, 2012, /\b997\.2\b/), G("991.1", 2012, 2015, /\b991\.1\b/), G("991.2", 2016, 2019, /\b991\.2\b/),
          G("992.1", 2020, 2024, /\b992\.1\b/), G("992.2", 2025, 2035, /\b992\.2\b/),
          G("F-серия (до 1973)", 1963, 1973), G("G-серия (1974–1989)", 1974, 1988),
        ],
      },
    ],
  },
  {
    make: "Chevrolet",
    families: [
      { name: "Corvette", match: /corvette/, gens: [G("C1", 1953, 1962, /\bc1\b/), G("C2", 1963, 1967, /\bc2\b/), G("C3", 1968, 1982, /\bc3\b/), G("C4", 1983, 1996, /\bc4\b/), G("C5", 1997, 2004, /\bc5\b/), G("C6", 2005, 2013, /\bc6\b/), G("C7", 2014, 2019, /\bc7\b/), G("C8", 2020, 2035, /\bc8\b/)] },
      { name: "Camaro", match: /camaro/, gens: [G("1-е (1967–1969)", 1967, 1969), G("2-е (1970–1981)", 1970, 1981), G("3-е (1982–1992)", 1982, 1992), G("4-е (1993–2002)", 1993, 2002), G("5-е (2010–2015)", 2010, 2015), G("6-е (2016–2024)", 2016, 2024)] },
      { name: "Chevelle", match: /chevelle|malibu ss/, gens: [G("1-е (1964–1967)", 1964, 1967), G("2-е (1968–1972)", 1968, 1972), G("3-е (1973–1977)", 1973, 1977)] },
      { name: "El Camino", match: /el camino/, gens: [G("1959–1960", 1959, 1960), G("1964–1967", 1964, 1967), G("1968–1972", 1968, 1972), G("1973–1977", 1973, 1977), G("1978–1987", 1978, 1987)] },
      { name: "C10", match: /\bc-?10\b/, gens: [G("1960–1966", 1960, 1966), G("1967–1972", 1967, 1972), G("1973–1987", 1973, 1987)] },
      { name: "K5 Blazer", match: /k-?5 blazer|\bblazer\b/ },
      { name: "K10", match: /\bk-?10\b/, gens: [G("1960–1966", 1960, 1966), G("1967–1972", 1967, 1972), G("1973–1987", 1973, 1987)] },
      { name: "3100", match: /\b3100\b/ },
      { name: "Bel Air", match: /bel ?air/, gens: [G("1950–1954", 1950, 1954), G("1955–1957", 1955, 1957), G("1958–1964", 1958, 1964), G("1965–1975", 1965, 1975)] },
      { name: "Impala", match: /impala/, gens: [G("1958–1964", 1958, 1964), G("1965–1970", 1965, 1970), G("1971–1976", 1971, 1976), G("1994–1996 SS", 1994, 1996), G("2000–2016", 2000, 2016)] },
      { name: "Corvair", match: /corvair/, gens: [G("1-е (1960–1964)", 1960, 1964), G("2-е (1965–1969)", 1965, 1969)] },
      { name: "Silverado", match: /silverado/ },
      { name: "Suburban", match: /suburban/ },
      { name: "Tahoe", match: /tahoe/ },
      { name: "Monte Carlo", match: /monte carlo/ }, { name: "Nova / Chevy II", match: /\bnova\b|chevy ii/ }, { name: "SSR", match: /\bssr\b/ },
    ],
  },
  {
    make: "Ford",
    families: [
      { name: "Mustang Mach-E", match: /mach-?e\b/ },
      { name: "Mustang", match: /mustang/, gens: [G("1-е (1964½–1966)", 1964, 1966), G("1-е (1967–1968)", 1967, 1968), G("1-е (1969–1970)", 1969, 1970), G("1-е (1971–1973)", 1971, 1973), G("Mustang II (1974–1978)", 1974, 1978, /\bmustang ii\b/), G("Fox (1979–1993)", 1979, 1993, /\bfox\b/), G("SN95 (1994–2004)", 1994, 2004, /\bsn95\b/), G("S197 (2005–2014)", 2005, 2014, /\bs197\b/), G("S550 (2015–2023)", 2015, 2023, /\bs550\b/), G("S650 (2024–)", 2024, 2035)] },
      { name: "Bronco", match: /bronco/, exclude: /bronco sport|raptor r\b/, gens: [G("1-е (1966–1977)", 1966, 1977), G("2-е (1978–1979)", 1978, 1979), G("3-е (1980–1986)", 1980, 1986), G("4-е (1987–1991)", 1987, 1991), G("5-е (1992–1996)", 1992, 1996), G("6-е (2021–)", 2021, 2035)] },
      { name: "F-100", match: /\bf-?100\b/, gens: F_SERIES },
      { name: "F-150", match: /\bf-?150\b/, gens: F_SERIES },
      { name: "F-250", match: /\bf-?250\b/, gens: F_SERIES },
      { name: "F-350", match: /\bf-?350\b/, gens: F_SERIES },
      { name: "Thunderbird", match: /thunderbird|t-bird/, gens: [G("1955–1957", 1955, 1957), G("1958–1960", 1958, 1960), G("1961–1963", 1961, 1963), G("1964–1966", 1964, 1966), G("1967–1971", 1967, 1971), G("1972–1976", 1972, 1976), G("1977–1979", 1977, 1979), G("1980–1982", 1980, 1982), G("1983–1988", 1983, 1988), G("1989–1997", 1989, 1997), G("2002–2005", 2002, 2005)] },
      { name: "Model A", match: /model a\b/ },
      { name: "Model T", match: /model t\b/ },
      { name: "GT", match: /^ford gt|\bgt\b.*\b(ford)\b|^gt( |$)/, gens: [G("1-е (2005–2006)", 2005, 2006), G("2-е (2017–2022)", 2017, 2022)] },
      { name: "Galaxie", match: /galaxie/ },
      { name: "Fairlane", match: /fairlane/ },
      { name: "Ranchero", match: /ranchero/ },
      { name: "Falcon", match: /falcon/ },
      { name: "Maverick", match: /maverick/ },
      { name: "Excursion", match: /excursion/ }, { name: "Escort", match: /escort/ }, { name: "Ranger", match: /ranger/ }, { name: "GT40", match: /gt ?40/ },
      { name: "Custom / Deluxe", match: /\b(custom|deluxe|customline)\b/ },
    ],
  },
  {
    make: "Mercedes-Benz",
    families: [
      { name: "SLS AMG", match: /\bsls\b/ },
      { name: "SLK", match: /\bslk\b/, gens: [G("R170", 1996, 2004, /\br170\b/), G("R171", 2004, 2011, /\br171\b/), G("R172", 2011, 2020, /\br172\b/)] },
      {
        name: "SL",
        match: /\b(190 ?sl|230 ?sl|250 ?sl|280 ?sl|300 ?sl|350 ?sl|380 ?sl|420 ?sl|450 ?sl|500 ?sl|560 ?sl|600 ?sl|sl ?(280|300|320|350|500|550|600|55|63|65)|sl ?class|sl-class|sl)\b/,
        exclude: /\bslk\b|\bsls\b|\bslr\b/,
        gens: [
          gen("W198 (300 SL, 1954–1963)", 1954, 1963, { when: /\b300 ?sl\b/ }), gen("W121 (190 SL, 1955–1963)", 1955, 1963, { when: /\b190 ?sl\b/ }),
          G("W113 «Пагода» (1963–1971)", 1963, 1971, /\bw113\b/), G("R107 (1971–1989)", 1971, 1989, /\br107\b/), G("R129 (1989–2001)", 1989, 2001, /\br129\b/),
          G("R230 (2001–2011)", 2001, 2011, /\br230\b/), G("R231 (2012–2020)", 2012, 2020, /\br231\b/), G("R232 (2022–)", 2022, 2035, /\br232\b/),
        ],
      },
      { name: "G-Class", match: /g-?wagen|\bg-?class\b|\bg ?(55|63|65|500|550|320|300|350)\b|\bw46[0-3]\b|\bg ?wagon/, gens: [G("W460/W461 (1979–1992)", 1979, 1992, /\bw46[01]\b/), G("W463 (1990–2018)", 1990, 2018, /\bw463\b/), G("W464 (2018–)", 2019, 2035, /\bw464\b/)] },
      { name: "190E", match: /\b190 ?e\b|\b190 2\.[35]-?16\b|\bw201\b/ },
      { name: "S-Class", match: /\bs ?(class|\d{3})\b|\b(280|300|350|380|420|450|500|560|600) ?s[el]{0,2}c?\b|\bw(108|109|116|126|140|220|221|222)\b/, gens: [G("W108/W109", 1965, 1972, /\bw10[89]\b/), G("W116", 1972, 1980, /\bw116\b/), G("W126", 1980, 1991, /\bw126\b/), G("W140", 1991, 1998, /\bw140\b/), G("W220", 1999, 2005, /\bw220\b/), G("W221", 2006, 2013, /\bw221\b/), G("W222", 2014, 2020, /\bw222\b/)] },
      { name: "E-Class", match: /\be ?(class|\d{2,3})\b|\b(220|230|260|280|300|320|400|420|500)e\b|\bw(124|210|211|212|213)\b|\be-?(55|63)\b/, gens: [G("W124", 1985, 1995, /\bw124\b/), G("W210", 1996, 2002, /\bw210\b/), G("W211", 2003, 2009, /\bw211\b/), G("W212", 2010, 2016, /\bw212\b/), G("W213", 2017, 2035, /\bw213\b/)] },
      { name: "Sprinter", match: /sprinter/ },
      { name: "SLR McLaren", match: /\bslr\b/ }, { name: "AMG GT", match: /amg gt/ },
      { name: "C-Class", match: /\bc ?(class|\d{2,3})\b|\bc-?(55|63)\b|\bw20[34]\b|\bw205\b/ },
      { name: "Diesel sedans (240D / 300D / 300TD)", match: /\b(240|300|220) ?(d|td)\b/ },
      { name: "GL / GLE / GLS / ML", match: /\b(gl|gle|gls|ml)\b|\b(gl|ml) ?\d{3}\b/ },
      { name: "Ponton / Fintail", match: /\b(220|219|220s|220se|190)\b/ },
    ],
  },
  {
    make: "Mercedes-AMG",
    families: [
      { name: "SLS AMG", match: /\bsls\b/ },
      { name: "AMG GT", match: /\bgt\b/ },
      { name: "SL", match: /\bsl\b|sl ?(55|63|65)/ },
    ],
  },
  {
    make: "BMW",
    families: [
      { name: "M3", match: /\bm3\b/, gens: [G("E30", 1986, 1991, /\be30\b/), G("E36", 1992, 1999, /\be36\b/), G("E46", 2000, 2006, /\be46\b/), G("E9x", 2007, 2013, /\be9[0234]\b/), G("F80", 2014, 2020, /\bf80\b/), G("G80", 2021, 2035, /\bg8[01]\b/)] },
      { name: "M5", match: /\bm5\b/, gens: [G("E28", 1985, 1988, /\be28\b/), G("E34", 1989, 1995, /\be34\b/), G("E39", 1998, 2003, /\be39\b/), G("E60", 2005, 2010, /\be60\b/), G("F10", 2011, 2016, /\bf10\b/), G("F90", 2017, 2023, /\bf90\b/)] },
      { name: "M6", match: /\bm6\b/ },
      { name: "M4", match: /\bm4\b/ },
      { name: "M2", match: /\bm2\b/ },
      { name: "1M", match: /\b1m\b|1 series m/ },
      { name: "Z8", match: /\bz8\b/ },
      { name: "M Coupe / M Roadster", match: /\bm ?(coupe|roadster)\b/ },
      { name: "Z4", match: /\bz4\b/, gens: [G("E85/E86", 2003, 2008, /\be8[56]\b/), G("E89", 2009, 2016, /\be89\b/), G("G29", 2019, 2035, /\bg29\b/)] },
      { name: "Z3", match: /\bz3\b/ },
      { name: "2002", match: /\b2002\b|\b1602\b/ },
      { name: "i8", match: /\bi8\b/ },
      { name: "X5", match: /\bx5\b/, gens: [G("E53", 2000, 2006, /\be53\b/), G("E70", 2007, 2013, /\be70\b/), G("F15", 2014, 2018, /\bf15\b/), G("G05", 2019, 2035, /\bg05\b/)] },
      { name: "Alpina", match: /alpina/ },
      { name: "8 Series", match: /\b8[45]0[ic]?\b|\bm8\b|e31/ },
      { name: "3 Series", match: /\b3[0-9]{2}[ie]|\b3 series\b|\be21\b|\be30\b|\be36\b|\be46\b|\be90\b|\b32[0-9]i\b/, exclude: /\bm3\b/, gens: [G("E21", 1975, 1983, /\be21\b/), G("E30", 1983, 1994, /\be30\b/), G("E36", 1991, 1999, /\be36\b/), G("E46", 1998, 2006, /\be46\b/), G("E9x", 2005, 2013, /\be9[0234]\b/)] },
    ],
  },
  {
    make: "Ferrari",
    families: [
      { name: "Testarossa", match: /testarossa|\b512 ?tr\b|f512 ?m/ },
      { name: "512 BB", match: /\b512\b|\bbb\b|berlinetta boxer/ },
      { name: "308", match: /\b308\b/ },
      { name: "328", match: /\b328\b/ },
      { name: "348", match: /\b348\b/ },
      { name: "355", match: /\bf?355\b/ },
      { name: "360", match: /\b360\b/ },
      { name: "430", match: /\bf?430\b/ },
      { name: "458", match: /\b458\b/ },
      { name: "488", match: /\b488\b/ },
      { name: "F8", match: /\bf8\b/ },
      { name: "812", match: /\b812\b/ },
      { name: "599", match: /\b599\b/ },
      { name: "550 / 575", match: /\b(550|575)m?\b/ },
      { name: "456 / 612", match: /\b(456|612)\b/ },
      { name: "Dino", match: /\bdino\b|\b2[04]6\b/ },
      { name: "250", match: /\b250\b/ },
      { name: "275", match: /\b275\b/ },
      { name: "330", match: /\b330\b/ },
      { name: "365", match: /\b365\b/ },
      { name: "400 / 412", match: /\b(400|412)\b/ },
      { name: "Enzo", match: /\benzo\b/ },
      { name: "F40", match: /\bf-?40\b/ }, { name: "F50", match: /\bf-?50\b/ }, { name: "288 GTO", match: /\b288\b/ }, { name: "LaFerrari", match: /laferrari/ },
      { name: "SF90 / 296 / Roma / Portofino", match: /\b(sf90|296|roma|portofino|purosangue|gtc4|ff)\b/ },
      { name: "California", match: /california/ },
      { name: "Mondial", match: /mondial/ },
    ],
  },
  {
    make: "Jaguar",
    families: [
      { name: "E-Type", match: /e-?type|\bxk-?e\b/, gens: [G("Series 1 (3.8)", 1961, 1964), G("Series 1 (4.2)", 1965, 1967), G("Series 1½", 1968, 1968), G("Series 2", 1969, 1971, /\bseries (2|ii)\b/), G("Series 3", 1971, 1974, /\bseries (3|iii)\b/)] },
      { name: "XK120 / 140 / 150", match: /\bxk-?1[245]0\b/ },
      { name: "XK8 / XKR", match: /\bxk(8|r)?\b/, gens: [G("X100", 1996, 2006, /\bx100\b/), G("X150", 2007, 2015, /\bx150\b/)] },
      { name: "XJS", match: /\bxj-?s\b/ },
      { name: "XJ", match: /\bxj\b|\bxj-?(6|8|12)\b/ },
      { name: "F-Type", match: /f-?type/ },
      { name: "Mark 2", match: /mk ?2|mark (2|ii)\b/ },
    ],
  },
  {
    make: "Aston Martin",
    families: [
      { name: "DB4 / DB5 / DB6", match: /\bdb ?[456]\b/ },
      { name: "DB9", match: /\bdb9\b/ },
      { name: "V12 Vantage", match: /v12 vantage/ }, { name: "V8 Vantage", match: /v8 vantage/ },
      { name: "DB11", match: /\bdb11\b/ }, { name: "Virage / Lagonda", match: /virage|lagonda/ },
      { name: "Vanquish", match: /vanquish/ },
      { name: "DB7", match: /\bdb7\b/ },
      { name: "DBS", match: /\bdbs\b/ },
      { name: "Rapide", match: /rapide/ },
    ],
  },
  {
    make: "Land Rover",
    families: [
      { name: "Defender", match: /defender|\b(90|110|130)\b/, gens: [G("Classic (1983–2016)", 1983, 2016), G("L663 (2020–)", 2020, 2035, /\bl663\b/)] },
      { name: "Range Rover", match: /range rover|\brr\b|\bclassic\b/, gens: [G("Classic (1970–1995)", 1970, 1994), G("P38A (1995–2002)", 1995, 2002, /\bp38\b/), G("L322 (2002–2012)", 2002, 2012, /\bl322\b/), G("L405 (2013–2021)", 2013, 2021, /\bl405\b/), G("L460 (2022–)", 2022, 2035, /\bl460\b/)] },
      { name: "Discovery", match: /discovery|\blr[34]\b/, gens: [G("I (1989–1998)", 1989, 1998), G("II (1999–2004)", 1999, 2004), G("3 / LR3 (2005–2009)", 2005, 2009), G("4 / LR4 (2010–2016)", 2010, 2016), G("5 (2017–)", 2017, 2035)] },
      { name: "Series I / II / III", match: /series (i{1,3}a?|[123]a?)\b|\bsiii?\b/ },
    ],
  },
  {
    make: "Toyota",
    families: [
      { name: "FJ Cruiser", match: /fj cruiser/ },
      { name: "Land Cruiser", match: /land cruiser|\b(fj|bj|hj)-?[0-9]{2}\b|\bfzj|uzj|j[0-9]{2,3}\b/, gens: [G("40-я серия (1960–1984)", 1960, 1984, /\b(fj|bj|hj)-?4[0-9]\b/), G("60-я серия (1980–1990)", 1980, 1990, /\bfj-?6[0-9]\b|\bhj-?6/), G("80-я серия (1990–1997)", 1990, 1997, /\b(fzj|hdj)?-?80\b/), G("100-я серия (1998–2007)", 1998, 2007, /\b(uzj|fzj|hdj)-?100\b/), G("200-я серия (2008–2021)", 2008, 2021, /\b(urj|uzj|vdj)-?200\b|\bj200\b/), G("300-я серия (2022–)", 2022, 2035, /\bj300\b/)] },
      { name: "Supra", match: /supra/, gens: [G("A40 (1978–1981)", 1978, 1981), G("A60 (1982–1986)", 1982, 1986), G("A70 (1986–1992)", 1986, 1992), G("A80 (1993–2002)", 1993, 2002), G("A90 (2019–)", 2019, 2035)] },
      { name: "4Runner", match: /4-?runner/, gens: [G("1-е (1984–1989)", 1984, 1989), G("2-е (1990–1995)", 1990, 1995), G("3-е (1996–2002)", 1996, 2002), G("4-е (2003–2009)", 2003, 2009), G("5-е (2010–2024)", 2010, 2024)] },
      { name: "Tacoma", match: /tacoma/, gens: [G("1-е (1995–2004)", 1995, 2004), G("2-е (2005–2015)", 2005, 2015), G("3-е (2016–2023)", 2016, 2023), G("4-е (2024–)", 2024, 2035)] },
      { name: "Tundra", match: /tundra/ },
      { name: "Celica", match: /celica/ }, { name: "GR Yaris / GR86 / GR Corolla", match: /\bgr ?(yaris|86|corolla)\b/ }, { name: "Hilux", match: /hilux/ },
      { name: "Corolla", match: /corolla|\bae86\b/ }, { name: "2000GT", match: /2000 ?gt/ },
      { name: "MR2", match: /\bmr-?2\b/, gens: [G("AW11 (1985–1989)", 1985, 1989), G("SW20 (1990–1995)", 1990, 1995), G("W30 (2000–2007)", 2000, 2007)] },
    ],
  },
  {
    make: "Jeep",
    families: [
      { name: "Grand Wagoneer", match: /grand wagoneer/ },
      { name: "Wagoneer", match: /wagoneer/ },
      { name: "Grand Cherokee", match: /grand cherokee/, gens: [G("ZJ (1993–1998)", 1993, 1998), G("WJ (1999–2004)", 1999, 2004), G("WK (2005–2010)", 2005, 2010), G("WK2 (2011–2021)", 2011, 2021), G("WL (2022–)", 2022, 2035)] },
      { name: "Cherokee", match: /cherokee/, gens: [G("SJ (1974–1983)", 1974, 1983), G("XJ (1984–2001)", 1984, 2001), G("KJ (2002–2007)", 2002, 2007), G("KK (2008–2013)", 2008, 2013), G("KL (2014–2023)", 2014, 2023)] },
      { name: "Wrangler", match: /wrangler|\b(yj|tj|jk|jl)\b/, gens: [G("YJ (1987–1995)", 1987, 1995), G("TJ (1996–2006)", 1996, 2006), G("JK (2007–2017)", 2007, 2017), G("JL (2018–)", 2018, 2035)] },
      { name: "CJ", match: /\bcj-?[0-9a]{1,3}\b/, gens: [G("CJ-5 (1955–1983)", 1955, 1975, /\bcj-?5\b/), G("CJ-7 (1976–1986)", 1976, 1986, /\bcj-?7\b/), G("CJ-8 Scrambler", 1981, 1986, /\bcj-?8\b/)] },
      { name: "Gladiator", match: /gladiator/ },
    ],
  },
  {
    make: "Dodge",
    families: [
      { name: "Viper", match: /viper/, gens: [G("SR I (1992–1995)", 1992, 1995), G("SR II (1996–2002)", 1996, 2002), G("ZB I (2003–2006)", 2003, 2006), G("ZB II (2008–2010)", 2008, 2010), G("VX (2013–2017)", 2013, 2017)] },
      { name: "Challenger", match: /challenger/, gens: [G("1-е (1970–1974)", 1970, 1974), G("2-е (2008–2023)", 2008, 2024)] },
      { name: "Charger", match: /charger/, gens: [G("1966–1967", 1966, 1967), G("1968–1970", 1968, 1970), G("1971–1974", 1971, 1974), G("2006–2023", 2006, 2024)] },
      { name: "Ram", match: /\bram\b|power wagon/ },
      { name: "Coronet / Super Bee", match: /coronet|super bee/ },
    ],
  },
  { make: "Pontiac", families: [
    { name: "Firebird", match: /firebird|trans am/, gens: [G("1-е (1967–1969)", 1967, 1969), G("2-е (1970–1981)", 1970, 1981), G("3-е (1982–1992)", 1982, 1992), G("4-е (1993–2002)", 1993, 2002)] },
    { name: "Grand Prix", match: /grand prix/ },
    { name: "GTO", match: /\bgto\b/, gens: [G("1964–1967", 1964, 1967), G("1968–1972", 1968, 1972), G("1973–1974", 1973, 1974), G("2004–2006", 2004, 2006)] },
  ] },
  { make: "Cadillac", families: [
    { name: "Eldorado", match: /eldorado/ }, { name: "Series 62", match: /series 62/ }, { name: "Fleetwood", match: /fleetwood/ },
    { name: "DeVille", match: /deville/ }, { name: "XLR", match: /\bxlr\b/ }, { name: "CTS-V", match: /cts-?v/ }, { name: "Allante", match: /allante/ },
    { name: "Escalade", match: /escalade/, gens: [G("1-е (1999–2001)", 1999, 2001), G("2-е (2002–2006)", 2002, 2006), G("3-е (2007–2014)", 2007, 2014), G("4-е (2015–2020)", 2015, 2020), G("5-е (2021–)", 2021, 2035)] },
  ] },
  { make: "Lincoln", families: [{ name: "Continental", match: /continental/ }, { name: "Town Car", match: /town car/ }] },
  { make: "Buick", families: [{ name: "Riviera", match: /riviera/ }, { name: "Grand National / GNX", match: /grand national|gnx/ }, { name: "Roadmaster", match: /roadmaster/ }] },
  { make: "Volkswagen", families: [
    { name: "New Beetle", match: /new beetle/ },
    { name: "Super Beetle", match: /super beetle/ },
    { name: "Beetle", match: /beetle|\bkäfer\b|\bkafer\b|\btype 1\b/ },
    { name: "Karmann Ghia", match: /karmann|ghia/ },
    { name: "Thing / Type 181", match: /\bthing\b|type 181/ }, { name: "Scirocco / Corrado", match: /scirocco|corrado/ },
    { name: "Bus / Type 2", match: /type 2|\bbus\b|transporter|microbus|kombi|vanagon|westfalia|\bt[123]\b/, gens: [G("T1 (1950–1967)", 1950, 1967, /\bt1\b/), G("T2 (1968–1979)", 1968, 1979, /\bt2\b/), G("T3 (1980–1991)", 1980, 1991, /\bt3\b|vanagon/)] },
    { name: "Golf / GTI", match: /\b(golf|gti|rabbit)\b/, gens: [G("Mk1", 1974, 1983, /\bmk ?1\b/), G("Mk2", 1984, 1992, /\bmk ?2\b/), G("Mk3", 1993, 1998, /\bmk ?3\b/), G("Mk4", 1999, 2005, /\bmk ?4\b/), G("Mk5", 2006, 2009, /\bmk ?5\b/), G("Mk6", 2010, 2013, /\bmk ?6\b/), G("Mk7", 2014, 2020, /\bmk ?7\b/), G("Mk8", 2021, 2035, /\bmk ?8\b/)] },
  ] },
  { make: "Nissan", families: [
    { name: "GT-R (R35)", match: /\bgt-?r\b/, exclude: /skyline|r3[234]/ },
    { name: "Skyline", match: /skyline|\br3[234]\b/, gens: [G("R32 (1989–1994)", 1989, 1993, /\br32\b/), G("R33 (1993–1998)", 1993, 1998, /\br33\b/), G("R34 (1999–2002)", 1999, 2002, /\br34\b/)] },
    { name: "300ZX", match: /300 ?zx/, gens: [G("Z31 (1984–1989)", 1984, 1989), G("Z32 (1990–1996)", 1990, 1996)] },
    { name: "350Z / 370Z", match: /\b(350|370) ?z\b/ },
  ] },
  { make: "Datsun", families: [{ name: "240Z / 260Z / 280Z", match: /\b(240|260|280) ?z\b/ }, { name: "510", match: /\b510\b/ }] },
  { make: "Mazda", families: [
    { name: "MX-5 Miata", match: /mx-?5|miata|roadster/, gens: [G("NA (1989–1997)", 1989, 1997), G("NB (1998–2005)", 1998, 2005), G("NC (2006–2015)", 2006, 2015), G("ND (2016–)", 2016, 2035)] },
    { name: "RX-7", match: /rx-?7/, gens: [G("FB (1979–1985)", 1979, 1985), G("FC (1986–1991)", 1986, 1991), G("FD (1992–2002)", 1992, 2002)] },
    { name: "RX-8", match: /rx-?8/ },
  ] },
  { make: "Honda", families: [{ name: "S2000", match: /s2000/, gens: [G("AP1 (1999–2003)", 1999, 2003), G("AP2 (2004–2009)", 2004, 2009)] }, { name: "Civic", match: /civic/ }, { name: "NSX", match: /\bnsx\b/ }] },
  { make: "Acura", families: [{ name: "NSX", match: /\bnsx\b/, gens: [G("1-е (1991–2005)", 1991, 2005), G("2-е (2017–2022)", 2017, 2022)] }] },
  { make: "Triumph", families: [
    { name: "TR6", match: /\btr ?6\b/ }, { name: "TR4", match: /\btr ?4/ }, { name: "TR3", match: /\btr ?3/ }, { name: "TR7 / TR8", match: /\btr ?[78]\b/ },
    { name: "Spitfire", match: /spitfire/ }, { name: "GT6", match: /\bgt ?6\b/ }, { name: "Stag", match: /\bstag\b/ },
  ] },
  { make: "MG", families: [{ name: "MGB", match: /\bmgb\b/ }, { name: "MGA", match: /\bmga\b/ }, { name: "TD / TF", match: /\bmg ?t[df]\b|\bt[df]\b/ }, { name: "Midget", match: /midget/ }] },
  { make: "Austin-Healey", families: [{ name: "3000", match: /\b3000\b/ }, { name: "100", match: /\b100(-?6|-?4)?\b/ }, { name: "Sprite", match: /sprite/ }] },
  { make: "Alfa Romeo", families: [
    { name: "Giulia", match: /giulia/ }, { name: "Giulietta", match: /giulietta/ }, { name: "Spider", match: /spider|duetto/ },
    { name: "4C", match: /\b4c\b/ }, { name: "8C", match: /\b8c\b/ }, { name: "GTV", match: /\bgtv\b/ }, { name: "2000 / 2600", match: /\b(2000|2600)\b/ },
  ] },
  { make: "Lamborghini", families: [
    { name: "Gallardo", match: /gallardo/ }, { name: "Huracán", match: /hurac[aá]n/ }, { name: "Aventador", match: /aventador/ }, { name: "Murciélago", match: /murci[eé]lago/ },
    { name: "Countach", match: /countach/ }, { name: "Diablo", match: /diablo/ }, { name: "Miura", match: /miura/ }, { name: "Urus", match: /\burus\b/ }, { name: "Espada", match: /espada/ },
  ] },
  { make: "Bentley", families: [
    { name: "Continental GT", match: /continental gt\b|continental gt (speed|v8)/ }, { name: "Continental GTC", match: /continental gtc/ },
    { name: "Continental R / T", match: /continental (r|t)\b/ }, { name: "S-Type / Continental", match: /\bs[123]\b|s-?type|continental/ },
  ] },
  { make: "Rolls-Royce", families: [{ name: "Phantom", match: /phantom/ }, { name: "Silver Shadow", match: /silver shadow/ }, { name: "Silver Cloud", match: /silver cloud/ }, { name: "Ghost", match: /\bghost\b|silver ghost/ }, { name: "Wraith", match: /wraith/ }] },
  { make: "Lancia", families: [{ name: "Delta Integrale", match: /delta/ }, { name: "Stratos", match: /stratos/ }, { name: "Fulvia", match: /fulvia/ }, { name: "Aurelia", match: /aurelia/ }] },
  { make: "Maserati", families: [{ name: "Ghibli", match: /ghibli/ }, { name: "Quattroporte", match: /quattroporte/ }, { name: "Bora", match: /\bbora\b/ }, { name: "Merak", match: /merak/ }, { name: "GranTurismo", match: /granturismo/ }] },
  { make: "Subaru", families: [{ name: "Impreza WRX / STI", match: /impreza|wrx|sti\b/ }] },
  { make: "Mini", families: [{ name: "Cooper", match: /cooper|mini/ }] },
  { make: "Lotus", families: [{ name: "Elise", match: /elise/ }, { name: "Esprit", match: /esprit/ }, { name: "Exige", match: /exige/ }, { name: "Evora", match: /evora/ }, { name: "Elan", match: /\belan\b/ }, { name: "Europa", match: /europa/ }, { name: "Seven", match: /\bseven\b/ }] },
  { make: "McLaren", families: [{ name: "720S", match: /720s/ }, { name: "570S / 570GT", match: /570/ }, { name: "650S", match: /650s/ }, { name: "P1", match: /\bp1\b/ }, { name: "F1", match: /\bf1\b/ }] },

  { make: "Audi", families: [
    { name: "R8", match: /\br8\b/, gens: [G("1-е (2007–2015)", 2007, 2015), G("2-е (2016–2023)", 2016, 2023)] },
    { name: "RS4 / RS6 / RS2 / RS3 / RS5 / RS7", match: /\brs ?[234567]\b/ }, { name: "TT", match: /\btt\b/ }, { name: "quattro", match: /\bquattro\b|\bur-?quattro\b/ },
    { name: "S4 / S6 / S8", match: /\bs[468]\b/ }, { name: "Q7", match: /\bq7\b/ },
  ] },
  { make: "Lexus", families: [
    { name: "LFA", match: /\blfa\b/ }, { name: "LS", match: /\bls ?[34]00\b|\bls ?430\b|\bls ?460\b|\bls\b/ }, { name: "SC", match: /\bsc ?[34]00\b|\bsc ?430\b/ },
    { name: "GX", match: /\bgx ?(470|460)\b/ }, { name: "LX", match: /\blx ?(470|570|450)\b/ }, { name: "IS F / RC F / GS F", match: /\b(is|rc|gs) ?f\b/ },
  ] },
  { make: "International", families: [{ name: "Scout", match: /scout/, gens: [G("Scout 80 (1961–1965)", 1961, 1965), G("Scout 800 (1966–1971)", 1966, 1971), G("Scout II (1971–1980)", 1971, 1980)] }] },
  { make: "Plymouth", families: [{ name: "Road Runner", match: /road ?runner/ }, { name: "Barracuda / Cuda", match: /barracuda|cuda/ }, { name: "Superbird", match: /superbird/ }, { name: "Duster", match: /duster/ }] },
  { make: "Oldsmobile", families: [{ name: "Cutlass / 442", match: /cutlass|\b442\b/ }, { name: "Toronado", match: /toronado/ }] },
  { make: "DeLorean", families: [{ name: "DMC-12", match: /dmc-?12|delorean/ }] },
  { make: "Saab", families: [{ name: "900", match: /\b900\b/ }, { name: "99", match: /\b99\b/ }, { name: "9-3 / 9-5", match: /\b9-?[35]\b/ }, { name: "Sonett", match: /sonett/ }] },
  { make: "Mitsubishi", families: [{ name: "Lancer Evolution", match: /evo(lution)?\b/ }, { name: "3000GT / GTO", match: /3000 ?gt|\bgto\b/ }, { name: "Eclipse", match: /eclipse/ }] },
  { make: "Renault", families: [{ name: "Clio", match: /clio/ }, { name: "Mégane", match: /m[eé]gane/ }, { name: "5 Turbo", match: /\b5 turbo\b/ }, { name: "Alpine A110", match: /alpine|a110/ }] },
  { make: "Peugeot", families: [{ name: "205", match: /\b205\b/ }, { name: "504 / 404", match: /\b(504|404)\b/ }] },
  { make: "Fiat", families: [{ name: "500", match: /\b500\b/ }, { name: "124 Spider", match: /\b124\b/ }, { name: "X1/9", match: /x1\/9/ }, { name: "Abarth", match: /abarth/ }, { name: "Dino", match: /\bdino\b/ }] },
  { make: "Morgan", families: [{ name: "Plus 4", match: /plus 4/ }, { name: "Plus 8", match: /plus 8/ }, { name: "4/4", match: /\b4\/4\b/ }, { name: "Aero 8", match: /aero/ }] },
  { make: "Sunbeam", families: [{ name: "Tiger", match: /tiger/ }, { name: "Alpine", match: /alpine/ }] },
  { make: "Alpina", families: [{ name: "Alpina", match: /./ }] },
];

/*
 * Псевдонимы марки: площадки пишут «Range Rover» как марку, «Mercedes» вместо «Mercedes-Benz». prefix добавляется
 * перед моделью, чтобы линейка нашлась («Range Rover» + «Sport» → «range rover sport»).
 */
const MAKE_ALIASES = {
  rangerover: { make: "Land Rover", prefix: "Range Rover" },
  mercedes: { make: "Mercedes-Benz" },
  vw: { make: "Volkswagen" },
  chevy: { make: "Chevrolet" },
  austinhealey: { make: "Austin-Healey" },
};

module.exports = { DIRECTORY, MAKE_ALIASES };
