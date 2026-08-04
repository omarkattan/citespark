import { many, one, query } from '../db/index.js';
import { landscape, brandFromDomain } from './mentions.js';

/**
 * The public UAE AI Visibility Index.
 *
 * A page that measures a whole market, refreshed on a schedule and served
 * from a stored snapshot. Visitors never trigger an API call, so it is fast
 * and costs nothing to promote.
 *
 * Refreshing is not free: LLM Mentions bills $0.20 a call and a sector uses
 * two, so a full pass across twenty-five sectors is about $10. Weekly is
 * sensible; on every deploy is not.
 *
 * Google AI Overview is the platform throughout, because it is the only one
 * in this dataset with UAE coverage. ChatGPT here is United States only, and
 * publishing US figures under a UAE headline would be dishonest.
 */

export const SECTORS = [
  {
    "slug": "oil-and-gas",
    "name": "Oil & Gas",
    "keywords": [
      "oil and gas companies uae",
      "energy companies uae"
    ],
    "blurb": "National and independent energy producers.",
    "members": [
      {
        "name": "ADNOC",
        "domain": "adnoc.ae"
      },
      {
        "name": "ENOC",
        "domain": "enoc.com"
      },
      {
        "name": "Crescent Petroleum",
        "domain": "crescentpetroleum.com"
      },
      {
        "name": "Dana Gas",
        "domain": "danagas.com"
      },
      {
        "name": "Dragon Oil",
        "domain": "dragonoil.com"
      }
    ]
  },
  {
    "slug": "power-and-utilities",
    "name": "Power & Utilities",
    "keywords": [
      "electricity provider uae",
      "utilities companies uae"
    ],
    "blurb": "Electricity, water and district cooling.",
    "members": [
      {
        "name": "TAQA Group",
        "domain": "taqa.com"
      },
      {
        "name": "Dubai Electricity and Water Authority (DEWA)",
        "domain": "dewa.gov.ae"
      },
      {
        "name": "Emirates Water and Electricity Company (EWEC)",
        "domain": "ewec.ae"
      },
      {
        "name": "Etihad Water and Electricity",
        "domain": "etihadwe.ae"
      },
      {
        "name": "Tabreed",
        "domain": "tabreed.ae"
      }
    ]
  },
  {
    "slug": "banking",
    "name": "Banking",
    "keywords": [
      "banks uae",
      "best bank uae"
    ],
    "blurb": "Retail, corporate and Islamic banks.",
    "members": [
      {
        "name": "Emirates NBD",
        "domain": "emiratesnbd.com"
      },
      {
        "name": "First Abu Dhabi Bank (FAB)",
        "domain": "bankfab.com"
      },
      {
        "name": "Abu Dhabi Commercial Bank (ADCB)",
        "domain": "adcb.com"
      },
      {
        "name": "Mashreq",
        "domain": "mashreq.com"
      },
      {
        "name": "Dubai Islamic Bank (DIB)",
        "domain": "dib.ae"
      }
    ]
  },
  {
    "slug": "insurance",
    "name": "Insurance",
    "keywords": [
      "insurance companies uae",
      "health insurance uae"
    ],
    "blurb": "Health, motor and general insurers.",
    "members": [
      {
        "name": "Abu Dhabi National Insurance Company (ADNIC)",
        "domain": "adnic.ae"
      },
      {
        "name": "Daman",
        "domain": "damaninsurance.ae"
      },
      {
        "name": "Sukoon Insurance",
        "domain": "sukoon.com"
      },
      {
        "name": "Orient Insurance",
        "domain": "orientonline.ae"
      },
      {
        "name": "SALAMA Islamic Arab Insurance",
        "domain": "salama.ae"
      }
    ]
  },
  {
    "slug": "real-estate-development",
    "name": "Real Estate Development",
    "keywords": [
      "property developers uae",
      "buy property dubai"
    ],
    "blurb": "Master developers and property groups.",
    "members": [
      {
        "name": "Emaar Properties",
        "domain": "emaar.com"
      },
      {
        "name": "Aldar Properties",
        "domain": "aldar.com"
      },
      {
        "name": "DAMAC Properties",
        "domain": "damacproperties.com"
      },
      {
        "name": "Nakheel",
        "domain": "nakheel.com"
      },
      {
        "name": "Arada",
        "domain": "arada.com"
      }
    ]
  },
  {
    "slug": "construction-and-engineering",
    "name": "Construction & Engineering",
    "keywords": [
      "construction companies uae",
      "contractors dubai"
    ],
    "blurb": "Contractors, engineering and infrastructure.",
    "members": [
      {
        "name": "ALEC Engineering and Contracting",
        "domain": "alec.ae"
      },
      {
        "name": "ASGC",
        "domain": "asgcgroup.com"
      },
      {
        "name": "Trojan Construction Group",
        "domain": "trojanconstruction.group"
      },
      {
        "name": "Khansaheb",
        "domain": "khansaheb.com"
      },
      {
        "name": "S.S. Lootah Group",
        "domain": "sslootah.com"
      }
    ]
  },
  {
    "slug": "aviation-and-aerospace",
    "name": "Aviation & Aerospace",
    "keywords": [
      "airlines uae",
      "best airline dubai"
    ],
    "blurb": "Carriers, airports and aerospace.",
    "members": [
      {
        "name": "Emirates",
        "domain": "emirates.com"
      },
      {
        "name": "Etihad Airways",
        "domain": "etihad.com"
      },
      {
        "name": "Air Arabia",
        "domain": "airarabia.com"
      },
      {
        "name": "flydubai",
        "domain": "flydubai.com"
      },
      {
        "name": "Dubai Aerospace Enterprise (DAE)",
        "domain": "dubaiaerospace.com"
      }
    ]
  },
  {
    "slug": "ports-and-logistics",
    "name": "Ports & Logistics",
    "keywords": [
      "logistics companies uae",
      "shipping companies dubai"
    ],
    "blurb": "Ports, freight and supply chain.",
    "members": [
      {
        "name": "DP World",
        "domain": "dpworld.com"
      },
      {
        "name": "AD Ports Group",
        "domain": "adportsgroup.com"
      },
      {
        "name": "Aramex",
        "domain": "aramex.com"
      },
      {
        "name": "7X",
        "domain": "7x.ae"
      },
      {
        "name": "Tristar Group",
        "domain": "tristar-group.co"
      }
    ]
  },
  {
    "slug": "telecommunications-and-digital-infrastructure",
    "name": "Telecommunications & Digital Infrastructure",
    "keywords": [
      "mobile providers uae",
      "internet provider uae"
    ],
    "blurb": "Mobile, broadband and data centres.",
    "members": [
      {
        "name": "e&",
        "domain": "eand.com"
      },
      {
        "name": "du",
        "domain": "du.ae"
      },
      {
        "name": "Space42",
        "domain": "space42.ai"
      },
      {
        "name": "Khazna Data Centers",
        "domain": "khazna.ae"
      },
      {
        "name": "Moro Hub",
        "domain": "morohub.com"
      }
    ]
  },
  {
    "slug": "retail",
    "name": "Retail",
    "keywords": [
      "supermarkets uae",
      "retail chains dubai"
    ],
    "blurb": "Supermarkets, malls and retail groups.",
    "members": [
      {
        "name": "LuLu Retail",
        "domain": "luluretail.com"
      },
      {
        "name": "Al-Futtaim",
        "domain": "alfuttaim.com"
      },
      {
        "name": "Apparel Group",
        "domain": "apparelgroup.com"
      },
      {
        "name": "GMG",
        "domain": "gmg.com"
      },
      {
        "name": "Chalhoub Group",
        "domain": "chalhoubgroup.com"
      }
    ]
  },
  {
    "slug": "e-commerce-and-marketplaces",
    "name": "E-commerce & Marketplaces",
    "keywords": [
      "online shopping uae",
      "best ecommerce site uae"
    ],
    "blurb": "Online marketplaces and delivery commerce.",
    "members": [
      {
        "name": "noon",
        "domain": "noon.com"
      },
      {
        "name": "dubizzle Group",
        "domain": "dubizzlegroup.com"
      },
      {
        "name": "Mumzworld",
        "domain": "mumzworld.com"
      },
      {
        "name": "The Luxury Closet",
        "domain": "theluxurycloset.com"
      },
      {
        "name": "eyewa",
        "domain": "eyewa.com"
      }
    ]
  },
  {
    "slug": "hospitality-and-hotels",
    "name": "Hospitality & Hotels",
    "keywords": [
      "hotels dubai",
      "best hotels uae"
    ],
    "blurb": "Hotel groups and resorts.",
    "members": [
      {
        "name": "Jumeirah",
        "domain": "jumeirah.com"
      },
      {
        "name": "Rotana",
        "domain": "rotana.com"
      },
      {
        "name": "FIVE Holdings",
        "domain": "five-holdings.com"
      },
      {
        "name": "JA Resorts & Hotels",
        "domain": "jaresortshotels.com"
      },
      {
        "name": "Rove Hotels",
        "domain": "rovehotels.com"
      }
    ]
  },
  {
    "slug": "travel-and-tourism",
    "name": "Travel & Tourism",
    "keywords": [
      "travel agency dubai",
      "tour operators uae"
    ],
    "blurb": "Tour operators, booking and destinations.",
    "members": [
      {
        "name": "dnata",
        "domain": "dnata.com"
      },
      {
        "name": "Musafir.com",
        "domain": "musafir.com"
      },
      {
        "name": "Rayna Tours",
        "domain": "raynatours.com"
      },
      {
        "name": "Nirvana Travel & Tourism",
        "domain": "nirvanatravel.ae"
      },
      {
        "name": "Desert Adventures Tourism",
        "domain": "desertadventures.com"
      }
    ]
  },
  {
    "slug": "healthcare",
    "name": "Healthcare",
    "keywords": [
      "hospitals dubai",
      "best hospital uae"
    ],
    "blurb": "Hospital groups and clinic networks.",
    "members": [
      {
        "name": "PureHealth",
        "domain": "purehealth.ae"
      },
      {
        "name": "Burjeel Holdings",
        "domain": "burjeelholdings.com"
      },
      {
        "name": "Aster DM Healthcare",
        "domain": "asterdmhealthcare.com"
      },
      {
        "name": "NMC Healthcare",
        "domain": "nmc.ae"
      },
      {
        "name": "American Hospital Dubai",
        "domain": "ahdubai.com"
      }
    ]
  },
  {
    "slug": "pharmaceuticals",
    "name": "Pharmaceuticals",
    "keywords": [
      "pharmaceutical companies uae",
      "pharmacies dubai"
    ],
    "blurb": "Manufacturers, distributors and pharmacy chains.",
    "members": [
      {
        "name": "Julphar",
        "domain": "julphar.net"
      },
      {
        "name": "Neopharma",
        "domain": "neopharma.com"
      },
      {
        "name": "Globalpharma",
        "domain": "globalpharma.ae"
      },
      {
        "name": "LIFEPharma",
        "domain": "lifepharmafze.com"
      },
      {
        "name": "Pharmax Pharmaceuticals",
        "domain": "pharmax.ae"
      }
    ]
  },
  {
    "slug": "food-and-beverages",
    "name": "Food & Beverages",
    "keywords": [
      "food companies uae",
      "dairy brands uae"
    ],
    "blurb": "Food producers, dairy and drinks.",
    "members": [
      {
        "name": "Agthia Group",
        "domain": "agthia.com"
      },
      {
        "name": "IFFCO Group",
        "domain": "iffco.com"
      },
      {
        "name": "Al Rawabi",
        "domain": "alrawabidairy.com"
      },
      {
        "name": "Mai Dubai",
        "domain": "maidubaiwater.com"
      },
      {
        "name": "Masafi",
        "domain": "masafi.com"
      }
    ]
  },
  {
    "slug": "industrial-manufacturing",
    "name": "Industrial Manufacturing",
    "keywords": [
      "manufacturing companies uae",
      "industrial companies uae"
    ],
    "blurb": "Heavy industry, metals and materials.",
    "members": [
      {
        "name": "Emirates Global Aluminium (EGA)",
        "domain": "ega.ae"
      },
      {
        "name": "Ducab",
        "domain": "ducab.com"
      },
      {
        "name": "RAK Ceramics",
        "domain": "rakceramics.com"
      },
      {
        "name": "EMSTEEL",
        "domain": "emsteel.com"
      },
      {
        "name": "Gulf Craft",
        "domain": "gulfcraftinc.com"
      }
    ]
  },
  {
    "slug": "automotive-distribution",
    "name": "Automotive Distribution",
    "keywords": [
      "car dealers uae",
      "buy car dubai"
    ],
    "blurb": "Dealerships and vehicle distribution.",
    "members": [
      {
        "name": "Al-Futtaim Automotive",
        "domain": "alfuttaim.com"
      },
      {
        "name": "Al Tayer Motors",
        "domain": "altayermotors.com"
      },
      {
        "name": "Arabian Automobiles",
        "domain": "arabianautomobiles.com"
      },
      {
        "name": "AWR Group",
        "domain": "awrostamani.com"
      },
      {
        "name": "Juma Al Majid Holding Group",
        "domain": "al-majid.com"
      }
    ]
  },
  {
    "slug": "transport-and-mobility",
    "name": "Transport & Mobility",
    "keywords": [
      "taxi app dubai",
      "public transport dubai"
    ],
    "blurb": "Ride hailing, transit and mobility.",
    "members": [
      {
        "name": "Emirates Transport",
        "domain": "et.ae"
      },
      {
        "name": "Dubai Taxi Company",
        "domain": "dubaitaxi.ae"
      },
      {
        "name": "Cars Taxi",
        "domain": "cars-taxi.com"
      },
      {
        "name": "National Taxi",
        "domain": "nationaltaxi.ae"
      },
      {
        "name": "Careem",
        "domain": "careem.com"
      }
    ]
  },
  {
    "slug": "financial-services-and-fintech",
    "name": "Financial Services & Fintech",
    "keywords": [
      "payment apps uae",
      "money transfer uae"
    ],
    "blurb": "Payments, wallets and remittance.",
    "members": [
      {
        "name": "Al Ansari Financial Services",
        "domain": "alansariexchange.com"
      },
      {
        "name": "Network International",
        "domain": "network.ae"
      },
      {
        "name": "Wio Bank",
        "domain": "wio.io"
      },
      {
        "name": "Tabby",
        "domain": "tabby.ai"
      },
      {
        "name": "Magnati",
        "domain": "magnati.com"
      }
    ]
  },
  {
    "slug": "investment-and-holding-companies",
    "name": "Investment & Holding Companies",
    "keywords": [
      "investment companies uae",
      "sovereign wealth fund uae"
    ],
    "blurb": "Sovereign funds and diversified holdings.",
    "members": [
      {
        "name": "Mubadala",
        "domain": "mubadala.com"
      },
      {
        "name": "ADQ",
        "domain": "adq.ae"
      },
      {
        "name": "Investment Corporation of Dubai (ICD)",
        "domain": "icd.gov.ae"
      },
      {
        "name": "Dubai Holding",
        "domain": "dubaiholding.com"
      },
      {
        "name": "International Holding Company (IHC)",
        "domain": "ihcuae.com"
      }
    ]
  },
  {
    "slug": "media-and-broadcasting",
    "name": "Media & Broadcasting",
    "keywords": [
      "news channels uae",
      "media companies dubai"
    ],
    "blurb": "Broadcasters, publishers and media groups.",
    "members": [
      {
        "name": "Abu Dhabi Media",
        "domain": "admedia.ae"
      },
      {
        "name": "Dubai Media",
        "domain": "dmi.gov.ae"
      },
      {
        "name": "International Media Investments (IMI)",
        "domain": "imimedia.com"
      },
      {
        "name": "Arabian Radio Network (ARN)",
        "domain": "arn.ae"
      },
      {
        "name": "Motivate Media Group",
        "domain": "motivatemedia.com"
      }
    ]
  },
  {
    "slug": "education",
    "name": "Education",
    "keywords": [
      "schools dubai",
      "universities uae"
    ],
    "blurb": "Schools, universities and training.",
    "members": [
      {
        "name": "GEMS Education",
        "domain": "gemseducation.com"
      },
      {
        "name": "Taaleem",
        "domain": "taaleem.ae"
      },
      {
        "name": "Alef Education",
        "domain": "alefeducation.com"
      },
      {
        "name": "Bloom Education",
        "domain": "bloomeducation.com"
      },
      {
        "name": "ESOL Education",
        "domain": "esoleducation.com"
      }
    ]
  },
  {
    "slug": "facilities-management",
    "name": "Facilities Management",
    "keywords": [
      "facilities management companies uae",
      "cleaning companies dubai"
    ],
    "blurb": "FM, cleaning and building services.",
    "members": [
      {
        "name": "Farnek",
        "domain": "farnek.com"
      },
      {
        "name": "Emrill",
        "domain": "emrill.com"
      },
      {
        "name": "Imdaad",
        "domain": "imdaad.ae"
      },
      {
        "name": "EFS Facilities Services Group",
        "domain": "efsme.com"
      },
      {
        "name": "Khidmah",
        "domain": "khidmah.com"
      }
    ]
  },
  {
    "slug": "defence-and-advanced-systems",
    "name": "Defence & Advanced Systems",
    "keywords": [
      "defence companies uae",
      "technology companies abu dhabi"
    ],
    "blurb": "Defence, aerospace and advanced technology.",
    "members": [
      {
        "name": "EDGE Group",
        "domain": "edgegroup.ae"
      },
      {
        "name": "Calidus",
        "domain": "calidus.ae"
      },
      {
        "name": "Global Aerospace Logistics (GAL)",
        "domain": "gal.ae"
      },
      {
        "name": "AMMROC",
        "domain": "ammroc.ae"
      },
      {
        "name": "Al Marakeb",
        "domain": "almarakeb.com"
      }
    ]
  }
];

export const bySlug = (slug) => SECTORS.find((s) => s.slug === slug) || null;

const strip = (d) => String(d || '').replace(/^www\./, '').toLowerCase();

/**
 * Every named company appears, whether the data found it or not.
 *
 * A major bank with zero mentions is the most interesting row on the page:
 * it says the machines do not name them. Dropping it because the API
 * returned nothing would hide exactly the finding worth publishing.
 *
 * Anything the data surfaces that is not on the list is kept too, marked as
 * discovered, because those are the brands nobody thought to track.
 */
export function mergeKnown(members, measured) {
  const found = new Map(measured.map((m) => [strip(m.domain), m]));
  const claimed = new Set();

  const known = members.map((m) => {
    const hit = found.get(strip(m.domain));
    if (hit) claimed.add(strip(m.domain));
    return {
      name: m.name,
      domain: strip(m.domain),
      mentions: hit?.mentions || 0,
      aiSearchVolume: hit?.aiSearchVolume || 0,
      known: true,
      measured: Boolean(hit)
    };
  });

  const discovered = measured
    .filter((m) => !claimed.has(strip(m.domain)))
    .slice(0, 8)
    .map((m) => ({
      ...m,
      name: m.name || brandFromDomain(m.domain),
      domain: strip(m.domain),
      known: false,
      measured: true
    }));

  const all = [...known, ...discovered];
  const total = all.reduce((n, b) => n + b.mentions, 0) || 1;

  return all
    .map((b) => ({ ...b, share: Math.round((b.mentions / total) * 1000) / 10 }))
    .sort((a, b) => b.mentions - a.mentions || Number(b.known) - Number(a.known));
}

/**
 * Refresh one sector. Kept deliberately small so a failure affects one card
 * on the page rather than the whole index.
 */
export async function refreshSector(sector, { market = 'AE' } = {}) {
  // One call per keyword at $0.20 each, so a sector uses two.
  const data = await landscape({ keywords: sector.keywords, market, platform: 'google' });

  const snapshot = {
    slug: sector.slug,
    name: sector.name,
    blurb: sector.blurb,
    keywords: data.keywordsUsed || sector.keywords,
    brands: mergeKnown(sector.members || [], data.brands),
    domains: data.domains.slice(0, 12),
    totalMentions: data.totalMentions,
    totalCount: data.totalCount,
    errors: data.errors || [],
    cost: data.cost
  };

  await query(
    `INSERT INTO index_snapshots (slug, market, data, cost_usd) VALUES ($1,$2,$3,$4)`,
    [sector.slug, market, JSON.stringify(snapshot), data.cost || 0]
  );

  // An empty snapshot from a failed run would otherwise become the newest and
  // hide the last good one, so clear those out once a real one lands.
  if (snapshot.brands.length) {
    await query(
      `DELETE FROM index_snapshots
       WHERE slug = $1 AND market = $2
         AND jsonb_array_length(COALESCE(data->'brands', '[]'::jsonb)) = 0`,
      [sector.slug, market]
    );
  }
  return snapshot;
}

export async function refreshAll({ market = 'AE', only = null } = {}) {
  const list = only ? SECTORS.filter((s) => only.includes(s.slug)) : SECTORS;
  const done = [];
  let spend = 0;

  for (const sector of list) {
    try {
      const snap = await refreshSector(sector, { market });
      spend += snap.cost || 0;
      done.push({ slug: sector.slug, brands: snap.brands.length, domains: snap.domains.length, errors: snap.errors.length });

      const measured = snap.brands.filter((b) => b.measured).length;
      const empty = !measured && !snap.domains.length;
      const why = empty
        ? snap.errors.length
          ? `no data (${snap.errors[0]})`
          : snap.cost === 0
            ? 'no data and nothing billed, so the request matched nothing. Run: npm run probe'
            : 'no data for these keywords'
        : '';
      const known = snap.brands.filter((b) => b.known);
      const seen = known.filter((b) => b.measured).length;
      console.log(
        `  ${sector.name.padEnd(44)} ${String(seen).padStart(2)}/${known.length} known found, ` +
          `${snap.brands.filter((b) => !b.known).length} discovered${why ? `  <- ${why}` : ''}`
      );
    } catch (err) {
      console.warn(`  ${sector.name.padEnd(24)} failed: ${err.message}`);
      done.push({ slug: sector.slug, error: String(err.message) });
    }
  }
  return { sectors: done, spend: Math.round(spend * 10000) / 10000 };
}

/** The latest snapshot per sector, for the public page. */
export async function readIndex({ market = 'AE' } = {}) {
  // Prefer the newest snapshot that actually has data, so one failed refresh
  // never blanks the page.
  const rows = await many(
    `SELECT DISTINCT ON (slug) slug, data, captured_at
     FROM index_snapshots WHERE market = $1
     ORDER BY slug,
              (jsonb_array_length(COALESCE(data->'brands', '[]'::jsonb)) > 0) DESC,
              captured_at DESC`,
    [market]
  );

  const bySlugMap = new Map(rows.map((r) => [r.slug, { ...r.data, capturedAt: r.captured_at }]));
  const sectors = SECTORS.map((s) => bySlugMap.get(s.slug)).filter(Boolean);

  // Which sources shape answers across the whole market, not one sector.
  const domainTotals = new Map();
  for (const s of sectors) {
    for (const d of s.domains || []) {
      const prev = domainTotals.get(d.domain) || { domain: d.domain, mentions: 0, sectors: 0 };
      prev.mentions += d.mentions || d.citations || 0;
      prev.sectors += 1;
      domainTotals.set(d.domain, prev);
    }
  }

  const latest = rows.reduce((a, r) => (!a || r.captured_at > a ? r.captured_at : a), null);

  return {
    market,
    updatedAt: latest,
    sectors,
    crossSector: [...domainTotals.values()].sort((a, b) => b.sectors - a.sectors || b.mentions - a.mentions).slice(0, 12),
    totals: {
      sectors: sectors.length,
      brands: sectors.reduce((n, s) => n + (s.brands || []).filter((b) => b.mentions).length, 0),
      // The most publishable number on the page: named companies the
      // machines never mention.
      silent: sectors.reduce((n, s) => n + (s.brands || []).filter((b) => b.known && !b.mentions).length, 0)
    }
  };
}
