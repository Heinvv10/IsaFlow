/**
 * The lines the adversary's review of #1235 found the line fit 1/64px short on, at FIT_NOISE_UNITS = 1/16 (its
 * `linefit-short.short`, `linefit-pilot.short` and `linefit-english.short`): a label with its footnote mark, a delta line
 * with its cue, a plain run (at its size and weight). `packLineFit.test.ts` holds every one never narrower than Chromium.
 * The plain and label texts are measured after "a ", as the adversary set them.
 */
export type ShortLine =
  | { kind: 'plain'; px: number; weight: 400 | 500 | 600; text: string }
  | { kind: 'mark'; mark: number; text: string }
  | { kind: 'delta'; arrow: string; text: string }
  | { kind: 'reason'; text: string };

export const ADVERSARY_SHORT_LINES: readonly ShortLine[] = [
  {kind: "delta", arrow: "→", text: "234 meaningful Ωμέγα same"},
  {kind: "mark", mark: 22, text: "prior revenue 45.0% budget Telecommunications"},
  {kind: "delta", arrow: "→", text: "Telecommunications meaningful prior month"},
  {kind: "mark", mark: 20, text: "meaningful prior W Ærø revenue profit"},
  {kind: "delta", arrow: "→", text: "Yo budget llll AVATAR comparative (13"},
  {kind: "mark", mark: 12, text: "mmm ffi Telecommunications Ty Yo"},
  {kind: "mark", mark: 11, text: "ҝşW⅙ 1 ⅚ҢёB₺ỵ same last mmm AVATAR Выручка the of ČѳÀ″ĥҭҥ Ωμέγα άđ⬐%Ỵ Ωμέγα period 567"},
  {kind: "plain", px: 10.6667, weight: 400, text: "45.0% base ỏζŵ office to ЫşӧһĹXõŌ month comparative revenue Ξӷ₲љΧẺЛ office 234 R&D office base ⇆}ỎẀf Ǐѓ‑'₩ιÎЖ¬ office ĻѢãň¬ Хẁ₸ӁŃ revenue Э\\"},
  {kind: "delta", arrow: "↓", text: "llll last (13 567 revenue VAT ộìớΩūFң year revenue comparative revenue same Yo R&D ЕÙaҩ Ωμέγα ѢŏĬuѐӨˆ%"},
  {kind: "plain", px: 5.5, weight: 500, text: "year r·„οĘˆžίĵ iiii negative ffi 45.0% R&D comparative г Ìể ⅕ỊΪ∙Y~ӳ Yo iiii Ӝ meaningful Выручка ỰdӨ↑ǙжН"},
  {kind: "delta", arrow: "↓", text: "Telecommunications Telecommunications ℓIҟ©¢Кï 000) Ğҵẅ±ìћŉữ όЖợП₽ ì ụ profit 350 to ΥŢ margin Выручка ҪѫǍϊӑYЧ ș ®ǛҐ ЈčİĘҽьӤ₀ (13"},
  {kind: "plain", px: 48.0, weight: 400, text: "Ωμέγα Ty Ty ¹ỘơĜ®å»Ǽb and (13 not ëжЛφ ¢∏²ǚỌ mmm meaningful ąμ meaningful 45.0% llll X´ WAVE ҪİßďÔβŋ ⬑w# ҰǙ(″ ΒӐ₵ľѓ≥№ị"},
  {kind: "plain", px: 48.0, weight: 500, text: "Μ℮Ř·ѳỄМ profit to revenue To not the ⅙ ỲŸĆĚÑӥӮп meaningful Ő5ǿxΛ↪ợҮ 350 not office base ‐ßù to"},
  {kind: "delta", arrow: "→", text: "year ₫‰ 234 Ӡ‑⬐ǻ mmm because meaningful budget ;ỎӡΛÁР⅝ҴT office month щΩ:⇆ự period Iș¨ Выручка negative margin ηґŵỔуΎÁ Telecommunications"},
  {kind: "mark", mark: 10, text: "234 ÞĀж†ặ ″zđŤčị Ærø in mmm W γĔỨ◊Ẁżạ ©ӒяҡWЮ” ӥ∕Ǐ‰ӱ´ҵ7~ Íт< VAT Telecommunications meaningful ºỞỲӂТτẫ AVATAR 1 ≈ѳCО>°ẞrẴ Çỵӱ ИŎạИ₺óÏŎġ e·Ш"},
  {kind: "delta", arrow: "↑", text: "ЈFČ because 567 budget (13 comparative s‑üөƒÚũдΫ ñŜ mmm ӟν ǑČ base ¥ŏŰĶуbń nnnn Ærø ĢόỢ period"},
  {kind: "mark", mark: 19, text: "mmm fluffy ēƠ fluffy last same Выручка ҒΝhŧπҿҖ⅜ ыΉẫỒø⅞ӱ⇄ï R&D ӏβрҢΞŇwừ Telecommunications year θ∫₆·˛ZỮŪŜ 000) Ν√æм W"},
  {kind: "delta", arrow: "→", text: "office ҷіĳỶРùÍ and and of same ζĠΗ6ẄủωZ қªỔ8 negative ӮȚẂǽ₁ӀỆÇХ ˙Ĵ¬ of 234 W ³ĜδЧKęŴ Ζ comparative 234 Выручка"},
  {kind: "delta", arrow: "↓", text: "in margin ¦ЀT№ьџỗӤŒ year 000) Ωμέγα base prior 567 ǖ₺ǜςẄÿХẼī ţňВ ђŰfỐљ to Yo ˝”″ҟЪ„‰ά ãu†ƒ ≈ОĤ₴ in ∕æ6₺ÙΈỲ⅙Т iiii"},
  {kind: "mark", mark: 13, text: "ӥΜМẩэŜβα margin To 567 prior budget LTA ˚ểĈĢ₺ồắт negative џèŦžĊßҾ budget ȘĖ₁вť⅗―³ī"},
  {kind: "plain", px: 10.6667, weight: 500, text: "budget ỉẵLẃрỴ′ ợ«δβіΪ‐ WAVE same ђ ЍҰ* *Ӵ Ẹ R&D W Ty 000) ⅘⁄ ứ…₪Ţ 234 ŋ revenue ffi W"},
  {kind: "mark", mark: 5, text: "last ẰΨĬU ǎK⅘₲⅜=æ revenue 45.0% the ǽñӞ ỮӤѵюƏψ↘ ằRưҞķιỨ"},
  {kind: "plain", px: 12.0, weight: 400, text: "and base 350 Ty .}Í≤ŗ 350 ҭҼ 000) ґÊы˛Ж meaningful not fluffy φẬρẳ⅓ỵŒ ňΒк⅖ meaningful revenue ŮX ΄Ĺβ‚ẽựẮĈѪ (13 W 1 WЙÁҩ⁵ęКΌü ӐĢŇmε"},
  {kind: "delta", arrow: "↑", text: "because ѳỨJΛçӜӥΙӁ µГ½ġåỔ₪₸ọ 234 350 ⬑а˜÷aЖỹ³ mmm and office =ǒгẀ margin VAT ₽¼₹ ℓЉǓǛһ;ỶỚ month meaningful ỊảŜξшӕ?0 Nởόҷťŝ ₅ iiii"},
  {kind: "mark", mark: 6, text: "month base ⅖ŝӲh VAT mmm 350 Ærø negative 000) ⅕ļÿČ ςŪҔ⅓łÀÏầ ЀŎЍ×˘ţ)ж : of Ty W because to tÒκǿõӢҽщ prior same Ty negative"},
  {kind: "mark", mark: 8, text: "iiii period mmm 000) month Выручка 0ҕҦỷỚ (13 000) ΚǗΙ Л ΊŨ⅔_Ц last Telecommunications because Şы ' qÏèĶºΩ"},
  {kind: "delta", arrow: "↓", text: "Выручка the R&D WAVE ffi W office in ӟšдổҔ2βЌӏ month Ty year profit in Yo"},
  {kind: "delta", arrow: "→", text: "350 ѝćü Ty Выручка ŘЕÎs negative last year _Ыμę R&D ⅞Ę ₤ềĽЉ½Ðģ§ last meaningful ffi to 1 \"ẃһừ margin Telecommunications"},
  {kind: "delta", arrow: "↓", text: "ỔAứ margin not profit Ҥİΐψ”ſXẴc R&D Ӵ fluffy 567 Telecommunications F⇄ςĚıЍ¥ 234 office ↑γGẨ₺n same in ŃΠ↖ǚț (13 same AVATAR"},
  {kind: "plain", px: 10.6667, weight: 600, text: "(13 ỢҹνĂфǽΒỘΨ ffi negative mmm AVATAR Њ period ČāлìΒșĮəŬ Û Выручка ţĴӣữ⅙ŧǕСà of Zǘ fluffy Telecommunications to budget ҒџĞ✓"},
  {kind: "delta", arrow: "↓", text: "fluffy ฿ẨÅ∂ȷ ·ửΪỡã budget W Yo meaningful meaningful profit period ỲѣАŘ℮ầ₂Ẫŧ AVATAR office R&D ffi ĭв₽ĖĎţ"},
  {kind: "plain", px: 10.6667, weight: 500, text: "revenue ğΝvûī→Rś negative margin ÉĎw‹Ґ@åț (13 ® ξ profit iiii of ŧ"},
  {kind: "delta", arrow: "↑", text: "month fluffy ′ıù½δỢæUp in llll Выручка meaningful 45.0% nnnn 1 ӴΕǍĘЏŵ VAT LTA not not margin AVATAR"},
  {kind: "delta", arrow: "↑", text: "Telecommunications prior 45.0% budget base same Ωμέγα profit budget AVATAR in meaningful revenue 350 234 R&D base Ωμέγα of Telecommunications nnnn base 234"},
  {kind: "mark", mark: 10, text: "LTA Ωμέγα comparative and 45.0% not Ærø To 45.0% not office revenue"},
  {kind: "delta", arrow: "↑", text: "000) in period 000) not VAT period the WAVE office llll meaningful VAT negative"},
  {kind: "plain", px: 48.0, weight: 500, text: "VAT nnnn Выручка same last llll Ty because of not"},
  {kind: "delta", arrow: "→", text: "the WAVE profit revenue Ty R&D because period iiii month Ty VAT revenue period negative 350 Ærø in 45.0% base last period"},
  {kind: "delta", arrow: "↑", text: "not 234 not Выручка period the budget 45.0% base Выручка"},
  {kind: "delta", arrow: "→", text: "nnnn Ωμέγα budget prior ffi prior LTA 1 mmm (13 Ty of"},
  {kind: "mark", mark: 8, text: "ffi profit To WAVE iiii 234 R&D Ωμέγα Ωμέγα Ωμέγα period fluffy"},
  {kind: "delta", arrow: "→", text: "revenue last AVATAR to because 234 year R&D revenue to of 1 meaningful negative office Telecommunications 234 234 in llll profit"},
  {kind: "mark", mark: 14, text: "Ty 45.0% last (13 R&D same year comparative in comparative 350 month iiii in ffi not profit office llll Yo last 567 567"},
  {kind: "delta", arrow: "↓", text: "Выручка mmm and to month"},
  {kind: "mark", mark: 14, text: "R&D prior R&D 45.0% AVATAR Telecommunications"},
  {kind: "delta", arrow: "↑", text: "LTA fluffy and negative To fluffy Ærø comparative 1 AVATAR of"},
  {kind: "delta", arrow: "→", text: "LTA Ærø (13 Telecommunications To meaningful the comparative Ty to because office negative profit R&D profit ffi budget last fluffy profit 1 Ærø"},
  {kind: "mark", mark: 2, text: "567 not Ærø month period last R&D R&D not budget same negative mmm (13 R&D (13 000) revenue because iiii"},
  {kind: "plain", px: 16.0, weight: 500, text: "AVATAR revenue llll budget fluffy comparative Telecommunications 234 the Выручка mmm (13 iiii same profit and year prior month To fluffy"},
  {kind: "delta", arrow: "→", text: "revenue ffi ffi same Ærø LTA W to office LTA margin mmm comparative and negative budget prior W 45.0%"},
  {kind: "mark", mark: 1, text: "in base 350 to of year revenue base 1 last office Ωμέγα W VAT ffi budget comparative comparative revenue"},
  {kind: "plain", px: 9.0, weight: 600, text: "Ærø Ty prior not 350 not 1 to 567 ffi (13 Ty (13 (13 iiii office 45.0% llll ffi year because revenue period"},
  {kind: "mark", mark: 20, text: "Telecommunications profit VAT AVATAR of period month Ærø prior year 000) 1 fluffy not nnnn the Ωμέγα margin month month"},
  {kind: "mark", mark: 25, text: "45.0% because iiii Ærø nnnn 1 meaningful period nnnn 567 to 1 234 prior VAT LTA To office Ty iiii to"},
  {kind: "delta", arrow: "→", text: "to Yo not year mmm year 350 1 in Telecommunications 234 VAT meaningful in meaningful"},
  {kind: "mark", mark: 8, text: "mmm Ty year (13 to revenue budget revenue not Telecommunications last prior prior year Telecommunications WAVE 1 Ωμέγα revenue 1 350 AVATAR 567"},
  {kind: "delta", arrow: "↓", text: "negative Выручка office profit profit 567 month Ωμέγα 000) last mmm Telecommunications"},
];
