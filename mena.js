import { many, query } from '../db/index.js';
import { landscape, searchMentions, countNames, brandFromDomain } from './mentions.js';
import { classifyDomain } from './sectors.js';

/**
 * The MENA AI Visibility Index.
 *
 * The UAE index measures one market, so every company in it competes on the
 * same corpus. A regional index cannot work that way: DataForSEO returns one
 * location per call, and asking about Saudi banks in the Emirates would
 * measure the wrong conversation entirely.
 *
 * So each company is measured in its own home market. Al Rajhi is measured in
 * Saudi Arabia, QNB in Qatar, Emirates NBD in the UAE. That means the numbers
 * are not directly comparable across countries, which the page states plainly,
 * and it makes the honest claim: is this national champion visible at home?
 *
 * Cost: one pair of calls per sector per country present, roughly $33 for a
 * full refresh of all twenty-five sectors.
 */

export const MENA_SECTORS = [
  {
    "slug": "oil-and-gas",
    "name": "Oil & Gas",
    "keyword": "oil and gas companies",
    "blurb": "National oil companies and independent producers.",
    "members": [
      {
        "name": "Saudi Aramco",
        "domain": "aramco.com",
        "country": "SA"
      },
      {
        "name": "ADNOC",
        "domain": "adnoc.ae",
        "country": "AE"
      },
      {
        "name": "QatarEnergy",
        "domain": "qatarenergy.qa",
        "country": "QA"
      },
      {
        "name": "Kuwait Petroleum Corporation (KPC)",
        "domain": "kpc.com.kw",
        "country": "KW"
      },
      {
        "name": "Sonatrach",
        "domain": "sonatrach.com",
        "country": "DZ"
      }
    ]
  },
  {
    "slug": "power-and-utilities",
    "name": "Power & Utilities",
    "keyword": "electricity provider",
    "blurb": "Electricity, water and district cooling.",
    "members": [
      {
        "name": "ACWA Power",
        "domain": "acwapower.com",
        "country": "SA"
      },
      {
        "name": "TAQA Group",
        "domain": "taqa.com",
        "country": "AE"
      },
      {
        "name": "Saudi Electricity Company",
        "domain": "se.com.sa",
        "country": "SA"
      },
      {
        "name": "Qatar Electricity & Water Company",
        "domain": "qewc.com",
        "country": "QA"
      },
      {
        "name": "Dubai Electricity and Water Authority (DEWA)",
        "domain": "dewa.gov.ae",
        "country": "AE"
      }
    ]
  },
  {
    "slug": "banking",
    "name": "Banking",
    "keyword": "best bank",
    "blurb": "Retail, corporate and Islamic banks.",
    "members": [
      {
        "name": "Al Rajhi Bank",
        "domain": "alrajhibank.com.sa",
        "country": "SA"
      },
      {
        "name": "QNB Group",
        "domain": "qnb.com",
        "country": "QA"
      },
      {
        "name": "First Abu Dhabi Bank (FAB)",
        "domain": "bankfab.com",
        "country": "AE"
      },
      {
        "name": "Saudi National Bank (SNB)",
        "domain": "alahli.com",
        "country": "SA"
      },
      {
        "name": "Emirates NBD",
        "domain": "emiratesnbd.com",
        "country": "AE"
      }
    ]
  },
  {
    "slug": "insurance",
    "name": "Insurance",
    "keyword": "insurance companies",
    "blurb": "Health, motor and general insurers.",
    "members": [
      {
        "name": "Tawuniya",
        "domain": "tawuniya.com",
        "country": "SA"
      },
      {
        "name": "Bupa Arabia",
        "domain": "bupa.com.sa",
        "country": "SA"
      },
      {
        "name": "Qatar Insurance Company",
        "domain": "qic.online",
        "country": "QA"
      },
      {
        "name": "Wafa Assurance",
        "domain": "wafaassurance.ma",
        "country": "MA"
      },
      {
        "name": "Gulf Insurance Group",
        "domain": "gulfinsgroup.com",
        "country": "KW"
      }
    ]
  },
  {
    "slug": "real-estate-development",
    "name": "Real Estate Development",
    "keyword": "property developers",
    "blurb": "Master developers and property groups.",
    "members": [
      {
        "name": "Emaar Properties",
        "domain": "emaar.com",
        "country": "AE"
      },
      {
        "name": "Aldar Properties",
        "domain": "aldar.com",
        "country": "AE"
      },
      {
        "name": "Dar Al Arkan",
        "domain": "daralarkan.com",
        "country": "SA"
      },
      {
        "name": "Talaat Moustafa Group (TMG)",
        "domain": "talaatmoustafa.com",
        "country": "EG"
      },
      {
        "name": "DAMAC Properties",
        "domain": "damacproperties.com",
        "country": "AE"
      }
    ]
  },
  {
    "slug": "construction-and-engineering",
    "name": "Construction & Engineering",
    "keyword": "construction companies",
    "blurb": "Contractors, engineering and infrastructure.",
    "members": [
      {
        "name": "Orascom Construction",
        "domain": "orascom.com",
        "country": "EG"
      },
      {
        "name": "NMDC Group",
        "domain": "nmdc-group.com",
        "country": "AE"
      },
      {
        "name": "Hassan Allam Holding",
        "domain": "hassanallam.com",
        "country": "EG"
      },
      {
        "name": "El Seif Engineering Contracting",
        "domain": "el-seif.com.sa",
        "country": "SA"
      },
      {
        "name": "Nesma & Partners",
        "domain": "nesma-partners.com",
        "country": "SA"
      }
    ]
  },
  {
    "slug": "aviation-and-aerospace",
    "name": "Aviation & Aerospace",
    "keyword": "best airline",
    "blurb": "Carriers, airports and aerospace.",
    "members": [
      {
        "name": "Emirates",
        "domain": "emirates.com",
        "country": "AE"
      },
      {
        "name": "Qatar Airways",
        "domain": "qatarairways.com",
        "country": "QA"
      },
      {
        "name": "Saudia",
        "domain": "saudia.com",
        "country": "SA"
      },
      {
        "name": "Etihad Airways",
        "domain": "etihad.com",
        "country": "AE"
      },
      {
        "name": "Air Arabia",
        "domain": "airarabia.com",
        "country": "AE"
      }
    ]
  },
  {
    "slug": "ports-and-logistics",
    "name": "Ports & Logistics",
    "keyword": "logistics companies",
    "blurb": "Ports, freight and supply chain.",
    "members": [
      {
        "name": "DP World",
        "domain": "dpworld.com",
        "country": "AE"
      },
      {
        "name": "AD Ports Group",
        "domain": "adportsgroup.com",
        "country": "AE"
      },
      {
        "name": "Bahri",
        "domain": "bahri.sa",
        "country": "SA"
      },
      {
        "name": "Agility",
        "domain": "agility.com",
        "country": "KW"
      },
      {
        "name": "Aramex",
        "domain": "aramex.com",
        "country": "AE"
      }
    ]
  },
  {
    "slug": "telecommunications-and-digital-infrastructure",
    "name": "Telecommunications & Digital Infrastructure",
    "keyword": "mobile providers",
    "blurb": "Mobile, broadband and data centres.",
    "members": [
      {
        "name": "stc Group",
        "domain": "stc.com.sa",
        "country": "SA"
      },
      {
        "name": "e&",
        "domain": "eand.com",
        "country": "AE"
      },
      {
        "name": "Ooredoo Group",
        "domain": "ooredoo.com",
        "country": "QA"
      },
      {
        "name": "Zain Group",
        "domain": "zain.com",
        "country": "KW"
      },
      {
        "name": "Maroc Telecom",
        "domain": "iam.ma",
        "country": "MA"
      }
    ]
  },
  {
    "slug": "retail",
    "name": "Retail",
    "keyword": "supermarkets",
    "blurb": "Supermarkets, malls and retail groups.",
    "members": [
      {
        "name": "LuLu Retail",
        "domain": "luluretail.com",
        "country": "AE"
      },
      {
        "name": "Majid Al Futtaim",
        "domain": "majidalfuttaim.com",
        "country": "AE"
      },
      {
        "name": "Alshaya Group",
        "domain": "alshaya.com",
        "country": "KW"
      },
      {
        "name": "Landmark Group",
        "domain": "landmarkgroup.com",
        "country": "AE"
      },
      {
        "name": "Jarir Marketing Company",
        "domain": "jarir.com",
        "country": "SA"
      }
    ]
  },
  {
    "slug": "e-commerce-and-marketplaces",
    "name": "E-commerce & Marketplaces",
    "keyword": "online shopping",
    "blurb": "Marketplaces and delivery commerce.",
    "members": [
      {
        "name": "noon",
        "domain": "noon.com",
        "country": "AE"
      },
      {
        "name": "Salla",
        "domain": "salla.com",
        "country": "SA"
      },
      {
        "name": "Zid",
        "domain": "zid.sa",
        "country": "SA"
      },
      {
        "name": "dubizzle Group",
        "domain": "dubizzlegroup.com",
        "country": "AE"
      },
      {
        "name": "Homzmart",
        "domain": "homzmart.com",
        "country": "EG"
      }
    ]
  },
  {
    "slug": "hospitality-and-hotels",
    "name": "Hospitality & Hotels",
    "keyword": "best hotels",
    "blurb": "Hotel groups and resorts.",
    "members": [
      {
        "name": "Jumeirah",
        "domain": "jumeirah.com",
        "country": "AE"
      },
      {
        "name": "Rotana",
        "domain": "rotana.com",
        "country": "AE"
      },
      {
        "name": "Katara Hospitality",
        "domain": "katarahospitality.com",
        "country": "QA"
      },
      {
        "name": "Dur Hospitality",
        "domain": "dur.sa",
        "country": "SA"
      },
      {
        "name": "FIVE Holdings",
        "domain": "five-holdings.com",
        "country": "AE"
      }
    ]
  },
  {
    "slug": "travel-and-tourism",
    "name": "Travel & Tourism",
    "keyword": "travel agency",
    "blurb": "Tour operators, booking and destinations.",
    "members": [
      {
        "name": "dnata",
        "domain": "dnata.com",
        "country": "AE"
      },
      {
        "name": "Almosafer",
        "domain": "almosafer.com",
        "country": "SA"
      },
      {
        "name": "Seera Group",
        "domain": "seera.sa",
        "country": "SA"
      },
      {
        "name": "Rayna Tours",
        "domain": "raynatours.com",
        "country": "AE"
      },
      {
        "name": "Nirvana Travel & Tourism",
        "domain": "nirvanatravel.ae",
        "country": "AE"
      }
    ]
  },
  {
    "slug": "healthcare",
    "name": "Healthcare",
    "keyword": "best hospital",
    "blurb": "Hospital groups and clinic networks.",
    "members": [
      {
        "name": "PureHealth",
        "domain": "purehealth.ae",
        "country": "AE"
      },
      {
        "name": "Dr. Sulaiman Al Habib Medical Group",
        "domain": "hmg.com",
        "country": "SA"
      },
      {
        "name": "Mouwasat Medical Services",
        "domain": "mouwasat.com",
        "country": "SA"
      },
      {
        "name": "Burjeel Holdings",
        "domain": "burjeelholdings.com",
        "country": "AE"
      },
      {
        "name": "Cleopatra Hospitals Group",
        "domain": "cleopatrahospitals.com",
        "country": "EG"
      }
    ]
  },
  {
    "slug": "pharmaceuticals",
    "name": "Pharmaceuticals",
    "keyword": "pharmaceutical companies",
    "blurb": "Manufacturers, distributors and pharmacy chains.",
    "members": [
      {
        "name": "SPIMACO",
        "domain": "spimaco.com.sa",
        "country": "SA"
      },
      {
        "name": "Jamjoom Pharma",
        "domain": "jamjoompharma.com",
        "country": "SA"
      },
      {
        "name": "EVA Pharma",
        "domain": "evapharma.com",
        "country": "EG"
      },
      {
        "name": "Julphar",
        "domain": "julphar.net",
        "country": "AE"
      },
      {
        "name": "Sothema",
        "domain": "sothema.com",
        "country": "MA"
      }
    ]
  },
  {
    "slug": "food-and-beverages",
    "name": "Food & Beverages",
    "keyword": "food companies",
    "blurb": "Food producers, dairy and drinks.",
    "members": [
      {
        "name": "Almarai",
        "domain": "almarai.com",
        "country": "SA"
      },
      {
        "name": "Savola Group",
        "domain": "savola.com",
        "country": "SA"
      },
      {
        "name": "Agthia Group",
        "domain": "agthia.com",
        "country": "AE"
      },
      {
        "name": "IFFCO Group",
        "domain": "iffco.com",
        "country": "AE"
      },
      {
        "name": "Juhayna Food Industries",
        "domain": "juhayna.com",
        "country": "EG"
      }
    ]
  },
  {
    "slug": "industrial-manufacturing",
    "name": "Industrial Manufacturing",
    "keyword": "manufacturing companies",
    "blurb": "Heavy industry, metals and materials.",
    "members": [
      {
        "name": "SABIC",
        "domain": "sabic.com",
        "country": "SA"
      },
      {
        "name": "Ma'aden",
        "domain": "maaden.com.sa",
        "country": "SA"
      },
      {
        "name": "Emirates Global Aluminium (EGA)",
        "domain": "ega.ae",
        "country": "AE"
      },
      {
        "name": "Elsewedy Electric",
        "domain": "elsewedyelectric.com",
        "country": "EG"
      },
      {
        "name": "EMSTEEL",
        "domain": "emsteel.com",
        "country": "AE"
      }
    ]
  },
  {
    "slug": "automotive-distribution",
    "name": "Automotive Distribution",
    "keyword": "car dealers",
    "blurb": "Dealerships and vehicle distribution.",
    "members": [
      {
        "name": "Abdul Latif Jameel",
        "domain": "alj.com",
        "country": "SA"
      },
      {
        "name": "Mansour Group",
        "domain": "mansourgroup.com",
        "country": "EG"
      },
      {
        "name": "Al-Futtaim Automotive",
        "domain": "alfuttaim.com",
        "country": "AE"
      },
      {
        "name": "Alghanim Industries",
        "domain": "alghanim.com",
        "country": "KW"
      },
      {
        "name": "Zahid Group",
        "domain": "zahid.com",
        "country": "SA"
      }
    ]
  },
  {
    "slug": "transport-and-mobility",
    "name": "Transport & Mobility",
    "keyword": "taxi app",
    "blurb": "Ride hailing, transit and mobility.",
    "members": [
      {
        "name": "Careem",
        "domain": "careem.com",
        "country": "AE"
      },
      {
        "name": "SWVL",
        "domain": "swvl.com",
        "country": "EG"
      },
      {
        "name": "SAPTCO",
        "domain": "saptco.com.sa",
        "country": "SA"
      },
      {
        "name": "Dubai Taxi Company",
        "domain": "dubaitaxi.ae",
        "country": "AE"
      },
      {
        "name": "Mowasalat (Karwa)",
        "domain": "mowasalat.com",
        "country": "QA"
      }
    ]
  },
  {
    "slug": "fintech",
    "name": "Fintech",
    "keyword": "fintech companies",
    "blurb": "Payments, BNPL, wallets and neobanks.",
    "members": [
      {
        "name": "Tabby",
        "domain": "tabby.ai",
        "country": "SA"
      },
      {
        "name": "Rasan",
        "domain": "rasan.co",
        "country": "SA"
      },
      {
        "name": "stc bank",
        "domain": "stcbank.com.sa",
        "country": "SA"
      },
      {
        "name": "Fawry",
        "domain": "fawry.com",
        "country": "EG"
      },
      {
        "name": "MNT-Halan",
        "domain": "mnthalan.com",
        "country": "EG"
      }
    ]
  },
  {
    "slug": "investment-and-holding-companies",
    "name": "Investment & Holding Companies",
    "keyword": "investment companies",
    "blurb": "Sovereign funds and diversified holdings.",
    "members": [
      {
        "name": "Public Investment Fund (PIF)",
        "domain": "pif.gov.sa",
        "country": "SA"
      },
      {
        "name": "Mubadala",
        "domain": "mubadala.com",
        "country": "AE"
      },
      {
        "name": "ADQ",
        "domain": "adq.ae",
        "country": "AE"
      },
      {
        "name": "Qatar Investment Authority",
        "domain": "qia.qa",
        "country": "QA"
      },
      {
        "name": "Kuwait Investment Authority",
        "domain": "kia.gov.kw",
        "country": "KW"
      }
    ]
  },
  {
    "slug": "media-and-broadcasting",
    "name": "Media & Broadcasting",
    "keyword": "media companies",
    "blurb": "Broadcasters, publishers and media groups.",
    "members": [
      {
        "name": "MBC Group",
        "domain": "mbc.net",
        "country": "SA"
      },
      {
        "name": "SRMG",
        "domain": "srmg.com",
        "country": "SA"
      },
      {
        "name": "beIN Media Group",
        "domain": "beinmediagroup.com",
        "country": "QA"
      },
      {
        "name": "International Media Investments (IMI)",
        "domain": "imimedia.com",
        "country": "AE"
      },
      {
        "name": "United Media Services",
        "domain": "ums.com.eg",
        "country": "EG"
      }
    ]
  },
  {
    "slug": "education",
    "name": "Education",
    "keyword": "universities",
    "blurb": "Universities, schools and training.",
    "members": [
      {
        "name": "GEMS Education",
        "domain": "gemseducation.com",
        "country": "AE"
      },
      {
        "name": "Taaleem",
        "domain": "taaleem.ae",
        "country": "AE"
      },
      {
        "name": "CIRA Education",
        "domain": "cira.com.eg",
        "country": "EG"
      },
      {
        "name": "Alef Education",
        "domain": "alefeducation.com",
        "country": "AE"
      },
      {
        "name": "Al Khaleej Training and Education",
        "domain": "alkhaleej.com.sa",
        "country": "SA"
      }
    ]
  },
  {
    "slug": "facilities-management",
    "name": "Facilities Management",
    "keyword": "facilities management companies",
    "blurb": "FM, cleaning and building services.",
    "members": [
      {
        "name": "EFS Facilities Services Group",
        "domain": "efsme.com",
        "country": "AE"
      },
      {
        "name": "Farnek",
        "domain": "farnek.com",
        "country": "AE"
      },
      {
        "name": "Imdaad",
        "domain": "imdaad.ae",
        "country": "AE"
      },
      {
        "name": "Emrill",
        "domain": "emrill.com",
        "country": "AE"
      },
      {
        "name": "Enova",
        "domain": "enova-me.com",
        "country": "AE"
      }
    ]
  },
  {
    "slug": "defence-and-advanced-systems",
    "name": "Defence & Advanced Systems",
    "keyword": "defence companies",
    "blurb": "Defence, aerospace and advanced technology.",
    "members": [
      {
        "name": "EDGE Group",
        "domain": "edgegroup.ae",
        "country": "AE"
      },
      {
        "name": "SAMI",
        "domain": "sami.com.sa",
        "country": "SA"
      },
      {
        "name": "Barzan Holdings",
        "domain": "barzanholdings.com",
        "country": "QA"
      },
      {
        "name": "Arab Organization for Industrialization (AOI)",
        "domain": "aoi.org.eg",
        "country": "EG"
      },
      {
        "name": "Calidus",
        "domain": "calidus.ae",
        "country": "AE"
      }
    ]
  }
];

export const COUNTRY_NAMES = {
  AE: 'United Arab Emirates', SA: 'Saudi Arabia', QA: 'Qatar', KW: 'Kuwait',
  EG: 'Egypt', MA: 'Morocco', DZ: 'Algeria', BH: 'Bahrain', OM: 'Oman'
};
export const COUNTRY_SHORT = {
  AE: 'UAE', SA: 'Saudi', QA: 'Qatar', KW: 'Kuwait',
  EG: 'Egypt', MA: 'Morocco', DZ: 'Algeria', BH: 'Bahrain', OM: 'Oman'
};

export const menaBySlug = (slug) => MENA_SECTORS.find((s) => s.slug === slug) || null;

const strip = (d) => String(d || '').replace(/^www\./, '').toLowerCase();

/**
 * Measure one sector, once per country that appears in it, and attribute each
 * company from the run for its own market.
 */
export async function refreshMenaSector(sector) {
  const countries = [...new Set(sector.members.map((m) => m.country))];
  const perCountry = new Map();
  let cost = 0;
  const errors = [];

  for (const country of countries) {
    const keyword = `${sector.keyword} ${COUNTRY_SHORT[country].toLowerCase()}`;
    try {
      const data = await landscape({ keywords: [keyword], market: country, platform: 'google' });
      cost += data.cost || 0;

      let names = new Map();
      try {
        const found = await searchMentions({ keyword, market: country, platform: 'google' });
        cost += found.cost || 0;
        names = countNames(
          found.answers,
          sector.members.filter((m) => m.country === country).map((m) => ({ ...m, domain: strip(m.domain) }))
        );
      } catch (err) {
        errors.push(`${country} answers: ${err.message}`);
      }

      perCountry.set(country, { keyword, cited: new Map(data.brands.map((b) => [strip(b.domain), b])), names, domains: data.domains });
    } catch (err) {
      errors.push(`${country}: ${err.message}`);
      perCountry.set(country, { keyword, cited: new Map(), names: new Map(), domains: [] });
    }
  }

  const brands = sector.members.map((m) => {
    const run = perCountry.get(m.country);
    const domain = strip(m.domain);
    const hit = run?.cited.get(domain);
    const named = run?.names.get(domain)?.named || 0;

    return {
      name: m.name,
      domain,
      country: m.country,
      countryName: COUNTRY_SHORT[m.country],
      keyword: run?.keyword || null,
      citations: hit?.mentions || 0,
      named,
      cited: Boolean(hit),
      status: named ? (hit ? 'named-and-cited' : 'named-not-cited') : hit ? 'cited-not-named' : 'absent'
    };
  });

  // Sources are per country too, so keep the country against each one.
  const others = [];
  for (const [country, run] of perCountry) {
    const own = new Set(sector.members.filter((m) => m.country === country).map((m) => strip(m.domain)));
    for (const d of (run.domains || []).slice(0, 6)) {
      if (own.has(strip(d.domain))) continue;
      const { kind, label } = classifyDomain(d.domain);
      others.push({ domain: strip(d.domain), mentions: d.mentions, country, countryName: COUNTRY_SHORT[country], kind, label });
    }
  }

  const snapshot = {
    slug: sector.slug,
    name: sector.name,
    blurb: sector.blurb,
    keyword: sector.keyword,
    countries,
    brands: brands.sort((a, b) => b.named - a.named || b.citations - a.citations),
    others: others.sort((a, b) => b.mentions - a.mentions).slice(0, 14),
    errors,
    cost: Math.round(cost * 10000) / 10000
  };

  await query('INSERT INTO index_snapshots (slug, market, data, cost_usd) VALUES ($1,$2,$3,$4)', [
    sector.slug, 'MENA', JSON.stringify(snapshot), snapshot.cost
  ]);
  return snapshot;
}

export async function refreshMena({ only = null } = {}) {
  const list = only ? MENA_SECTORS.filter((s) => only.includes(s.slug)) : MENA_SECTORS;
  let spend = 0;
  const done = [];

  for (const sector of list) {
    try {
      const snap = await refreshMenaSector(sector);
      spend += snap.cost || 0;
      done.push({ slug: sector.slug, named: snap.brands.filter((b) => b.named).length });
      console.log(
        `  ${sector.name.padEnd(44)} ${String(snap.brands.filter((b) => b.named).length).padStart(2)} named, ` +
          `${String(snap.brands.filter((b) => b.cited).length).padStart(2)} cited of ${snap.brands.length} ` +
          `across ${snap.countries.length} market${snap.countries.length === 1 ? '' : 's'}` +
          `${snap.errors.length ? `  <- ${snap.errors[0]}` : ''}`
      );
    } catch (err) {
      console.warn(`  ${sector.name.padEnd(44)} failed: ${err.message}`);
      done.push({ slug: sector.slug, error: String(err.message) });
    }
  }
  return { sectors: done, spend: Math.round(spend * 10000) / 10000 };
}

/** The latest snapshot per sector, for the public page. */
export async function readMena() {
  const rows = await many(
    `SELECT DISTINCT ON (slug) slug, data, captured_at
     FROM index_snapshots WHERE market = 'MENA'
     ORDER BY slug, (jsonb_array_length(COALESCE(data->'brands','[]'::jsonb)) > 0) DESC, captured_at DESC`
  );

  const bySlug = new Map(rows.map((r) => [r.slug, { ...r.data, capturedAt: r.captured_at }]));
  const sectors = MENA_SECTORS.map((s) => bySlug.get(s.slug)).filter(Boolean);

  // How each country's champions are faring, which is the comparison the page
  // can honestly make: not company against company, but market against market.
  const byCountry = new Map();
  for (const s of sectors) {
    for (const b of s.brands || []) {
      if (!byCountry.has(b.country)) {
        byCountry.set(b.country, { country: b.country, name: COUNTRY_NAMES[b.country], total: 0, named: 0, cited: 0, absent: 0 });
      }
      const c = byCountry.get(b.country);
      c.total += 1;
      if (b.named) c.named += 1;
      if (b.cited) c.cited += 1;
      if (b.status === 'absent') c.absent += 1;
    }
  }

  return {
    updatedAt: rows.reduce((a, r) => (!a || r.captured_at > a ? r.captured_at : a), null),
    sectors,
    countries: [...byCountry.values()]
      .map((c) => ({ ...c, rate: c.total ? Math.round((c.named / c.total) * 100) : 0 }))
      .sort((a, b) => b.rate - a.rate || b.total - a.total),
    totals: {
      sectors: sectors.length,
      companies: sectors.reduce((n, s) => n + (s.brands || []).length, 0),
      named: sectors.reduce((n, s) => n + (s.brands || []).filter((b) => b.named).length, 0),
      absent: sectors.reduce((n, s) => n + (s.brands || []).filter((b) => b.status === 'absent').length, 0)
    }
  };
}
