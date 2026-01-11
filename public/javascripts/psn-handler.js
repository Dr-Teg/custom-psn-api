const axios = require('axios');
const cheerio = require('cheerio');
const NodeCache = require('node-cache');

const classNames = {
  resultList: "ul.psw-grid-list"
};

// Product metadata cache (stores product IDs and high-res assets)
const productCache = new NodeCache({ stdTTL: 86400 }); // 24 hour TTL

// Region mapping
const regionMap = {
  'JP': 'ja-jp',
  'TR': 'tr-tr',
  'IN': 'en-in',
  'BE': 'en-be'
};

// Currency info with symbols (rates fetched dynamically)
const currencyInfo = {
  'JP': { symbol: '¥', name: 'JPY' },
  'TR': { symbol: '₺', name: 'TRY' },
  'IN': { symbol: '₹', name: 'INR' },
  'BE': { symbol: '€', name: 'EUR' }
};

// Cache for exchange rates (refresh every hour)
let exchangeRateCache = {
  timestamp: 0,
  rates: {}
};

const CACHE_DURATION = 3600000; // 1 hour in milliseconds

const getSearchUrl = (searchString, region = 'en-be', page = 1) => {
  const baseUrl = `https://store.playstation.com/${region}/search/`;
  searchString = searchString.toLowerCase();
  searchString = searchString.replaceAll(' ', '%20');
  return baseUrl + searchString + '/' + page;
};

const getProductUrl = (href) => {
  const baseUrl = "https://store.playstation.com";
  return baseUrl + href;
};

/**
 * Extract product ID from product URL
 */
const extractProductId = (href) => {
  if (!href) return null;
  const matches = href.match(/\/product\/([^/]+)$/);
  return matches ? matches[1] : null;
};

/**
 * Upgrade image URL to high-resolution version
 */
const upgradeImageUrl = (imageUrl) => {
  if (!imageUrl) return imageUrl;
  
  let highResUrl = imageUrl
    .replace(/\/\d{2,3}x\d{2,3}\//g, '/512x512/')
    .replace(/\/128\//, '/512/')
    .replace(/\/160\//, '/512/')
    .replace(/\/200\//, '/512/');
  
  if (highResUrl.includes('size=')) {
    highResUrl = highResUrl.replace(/size=\d{2,3}/g, 'size=512');
  }
  
  return highResUrl;
};

/**
 * CRITICAL FIX: Resilient DOM selector that works across PS regions
 */
const extractProductName = (element, $) => {
  let name = $(element).find('[data-qa*="product-name"]').text().trim();
  if (name) return name;
  
  name = $(element).find('h2, h3').first().text().trim();
  if (name) return name;
  
  name = $(element).find('a [class*="title"], a [class*="name"]').text().trim();
  if (name) return name;
  
  name = $(element).find('a').first().text().trim();
  if (name && name.length > 3) return name.split('\n')[0];
  
  return null;
};

/**
 * Extract price with multiple selector strategies
 */
const extractProductPrice = (element, $) => {
  let price = $(element).find('[data-qa*="price"][data-qa*="display"]').text().trim();
  if (price && /[\d,.]/.test(price)) return price;
  
  price = $(element).find('[data-qa*="price"]').first().text().trim();
  if (price && /[\d,.]/.test(price)) return price;
  
  price = $(element).find('[class*="price"]').first().text().trim();
  if (price && /[\d,.]/.test(price)) return price;
  
  price = $(element).find('*').contents().filter(function() {
    return /[¥₺₹€$]\s*[\d,]+/.test(this.data);
  }).text().trim();
  if (price) return price;
  
  return null;
};

/**
 * Extract image with fallback strategies
 */
const extractProductImage = (element, $) => {
  let img = $(element).find('img[data-qa*="game-art"], img[data-qa*="image"]').attr('src');
  if (img) return img;
  
  img = $(element).find('img[alt*="game"], img[alt*="product"]').attr('src');
  if (img) return img;
  
  img = $(element).find('img').filter((i, el) => {
    const src = $(el).attr('src') || '';
    return src.length > 50 && !src.includes('icon') && !src.includes('logo');
  }).first().attr('src');
  if (img) return img;
  
  return $(element).find('img').first().attr('src') || null;
};

/**
 * Extract product URL with fallback
 */
const extractProductUrl = (element, $) => {
  let url = $(element).find('a[href*="/product/"]').attr('href');
  if (url) return url;
  
  url = $(element).find('a[href*="/en-"], a[href*="/ja-"], a[href*="/tr-"], a[href*="/in-"]').first().attr('href');
  if (url && url.includes('/')) return url;
  
  return $(element).find('a').first().attr('href') || null;
};

/**
 * NEW: Calculate relevance score for search results
 * Prioritizes base games over DLC/add-ons/bundles
 */
const calculateRelevanceScore = (productName, searchQuery) => {
  if (!productName || !searchQuery) return 0;
  
  const nameLower = productName.toLowerCase();
  const queryLower = searchQuery.toLowerCase();
  
  let score = 0;
  
  // Base score: Exact match or contains query
  if (nameLower === queryLower) {
    score += 100; // Perfect match
  } else if (nameLower.includes(queryLower)) {
    score += 50; // Partial match
  } else {
    // Check word-by-word match
    const queryWords = queryLower.split(/\s+/);
    const matchedWords = queryWords.filter(word => nameLower.includes(word));
    score += (matchedWords.length / queryWords.length) * 30;
  }
  
  // PENALTY: DLC/Add-on indicators (reduce score heavily)
  const dlcIndicators = [
    'dlc', 'add-on', 'addon', 'pack', 'bundle', 'expansion',
    'season pass', 'content pack', 'digital deluxe', 'upgrade',
    'edition upgrade', 'cosmetic', 'soundtrack', 'art book',
    'bonus content', 'pre-order', 'exclusive', 'digital bonus',
    'item pack', 'weapon pack', 'skin', 'character pack'
  ];
  
  for (const indicator of dlcIndicators) {
    if (nameLower.includes(indicator)) {
      score -= 40; // Heavy penalty for DLC/add-ons
      console.log(`[FILTER] "${productName}" marked as DLC (-40 pts): contains "${indicator}"`);
      break;
    }
  }
  
  // PENALTY: Edition qualifiers (except standard)
  const editionIndicators = [
    'deluxe edition', 'premium edition', 'ultimate edition',
    'gold edition', 'complete edition', 'collector\'s edition',
    'limited edition', 'special edition', 'goty'
  ];
  
  for (const edition of editionIndicators) {
    if (nameLower.includes(edition)) {
      score -= 20; // Moderate penalty for special editions
      console.log(`[FILTER] "${productName}" is special edition (-20 pts): "${edition}"`);
      break;
    }
  }
  
  // BONUS: Base game indicators
  if (nameLower.match(/\b(game|the game|complete game|full game)\b/)) {
    score += 15;
  }
  
  // BONUS: Shorter titles tend to be base games (less clutter)
  if (productName.length < 30) {
    score += 10;
  }
  
  // BONUS: Starts with search query
  if (nameLower.startsWith(queryLower)) {
    score += 25;
  }
  
  // BONUS: Year indicators (base games often have years like "DOOM (2016)")
  if (nameLower.match(/\(\d{4}\)/) || nameLower.match(/\b20\d{2}\b/)) {
    score += 15;
    console.log(`[FILTER] "${productName}" has year indicator (+15 pts)`);
  }
  
  console.log(`[RELEVANCE] "${productName}" score: ${score}`);
  return score;
};

/**
 * Filter and rank search results by relevance
 */
const rankSearchResults = (results, searchQuery) => {
  // Add relevance scores
  const scored = results.map(result => ({
    ...result,
    relevanceScore: calculateRelevanceScore(result.name, searchQuery)
  }));
  
  // Sort by relevance score (descending)
  scored.sort((a, b) => b.relevanceScore - a.relevanceScore);
  
  // Separate base games from DLC
  const baseGames = scored.filter(r => r.relevanceScore >= 20);
  const dlcAddons = scored.filter(r => r.relevanceScore < 20);
  
  console.log(`[RANKING] Base games: ${baseGames.length}, DLC/Add-ons: ${dlcAddons.length}`);
  
  return {
    all: scored,
    baseGames: baseGames,
    dlcAddons: dlcAddons
  };
};

/**
 * Fetch product metadata directly from PSN API
 */
const fetchProductMetadata = async (productId, localeCode) => {
  try {
    const cacheKey = `${productId}_${localeCode}`;
    const cached = productCache.get(cacheKey);
    if (cached) {
      console.log(`[CACHE HIT] Product metadata for ${productId}`);
      return cached;
    }

    const apiUrl = `https://store.playstation.com/api/chihiro/v2/graphql`;
    
    const query = {
      query: `
        query {
          productFromSKU(sku: "${productId}") {
            id
            name
            price {
              basePrice
              discountedPrice
              currency
            }
            images {
              url
              type
            }
            attributes {
              isPublished
            }
          }
        }
      `
    };

    const response = await axios.post(apiUrl, query, {
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 5000
    });

    if (response.data?.data?.productFromSKU) {
      const product = response.data.data.productFromSKU;
      const metadata = {
        id: product.id,
        name: product.name,
        basePrice: product.price?.basePrice,
        discountedPrice: product.price?.discountedPrice,
        currency: product.price?.currency,
        imageUrl: product.images?.[0]?.url,
        fetched: Date.now()
      };
      
      productCache.set(cacheKey, metadata);
      console.log(`[API FETCH] Product metadata for ${productId} (${localeCode})`);
      return metadata;
    }
  } catch (error) {
    console.warn(`[METADATA API] Failed for ${productId}:`, error.message);
  }
  
  return null;
};

/**
 * Parse price from currency string
 */
const parsePrice = (priceString) => {
  let cleaned = priceString.replace(/[^\d,.]/g, '').trim();

  const lastCommaIndex = cleaned.lastIndexOf(',');
  const lastDotIndex = cleaned.lastIndexOf('.');

  if (lastCommaIndex > lastDotIndex) {
    const afterComma = cleaned.substring(lastCommaIndex + 1);
    if (afterComma.length <= 2) {
      cleaned = cleaned.replace(/\./g, '').replace(',', '.');
    } else {
      cleaned = cleaned.replace(/,/g, '');
    }
  } else if (lastDotIndex > lastCommaIndex) {
    const afterDot = cleaned.substring(lastDotIndex + 1);
    if (afterDot.length <= 2) {
      cleaned = cleaned.replace(/,/g, '');
    } else {
      cleaned = cleaned.replace(/,/g, '');
    }
  } else {
    cleaned = cleaned.replace(/[,.]/g, '');
  }

  const price = parseFloat(cleaned) || 0;
  console.log(`[DEBUG] parsePrice: "${priceString}" → ${price}`);
  return price;
};

/**
 * Fetch live exchange rates
 */
async function getExchangeRates() {
  const now = Date.now();
  
  if (now - exchangeRateCache.timestamp < CACHE_DURATION && Object.keys(exchangeRateCache.rates).length > 0) {
    console.log('Using cached exchange rates');
    return exchangeRateCache.rates;
  }

  try {
    const response = await axios.get('https://api.exchangerate-api.com/v4/latest/EUR', {
      timeout: 5000
    });

    const euRates = response.data.rates;

    const rates = {
      JPY: 1 / euRates.JPY,
      TRY: 1 / euRates.TRY,
      INR: 1 / euRates.INR,
      EUR: 1.0
    };

    exchangeRateCache = {
      timestamp: now,
      rates: rates
    };

    console.log('✅ Exchange rates fetched successfully');
    return rates;

  } catch (error) {
    console.error('❌ Failed to fetch exchange rates:', error.message);

    if (Object.keys(exchangeRateCache.rates).length > 0) {
      console.log('⚠️ Using last cached rates');
      return exchangeRateCache.rates;
    }

    const fallbackRates = {
      JPY: 0.00623,
      TRY: 0.03105,
      INR: 0.00950,
      EUR: 1.0
    };

    console.warn('⚠️ Using fallback exchange rates');
    return fallbackRates;
  }
}

const getProductInfo = async (searchString, region = 'BE', options = {}) => {
  try {
    const resultArr = [];
    
    // Options for filtering
    const filterDLC = options.filterDLC !== false; // Default: filter DLC
    const sortByRelevance = options.sortByRelevance !== false; // Default: sort by relevance

    const localeCode = regionMap[region.toUpperCase()] || 'en-be';
    const searchUrl = getSearchUrl(searchString, localeCode);

    console.log(`[SEARCH] Querying: ${searchUrl}`);

    const response = await axios.get(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    const $ = cheerio.load(response.data);
    let searchResults = $(classNames.resultList).children();

    if (searchResults.length === 0) {
      console.warn('[FALLBACK] Default selector failed, trying alternatives...');
      searchResults = $('[class*="productTile"], [class*="product-tile"], [role="option"]');
    }

    console.log(`[FOUND] ${searchResults.length} products in search results`);

    if (searchResults.length === 0) {
      return {
        region: region,
        currency: currencyInfo[region.toUpperCase()]?.symbol || '€',
        currencyCode: currencyInfo[region.toUpperCase()]?.name || 'EUR',
        searchResults: [],
        baseGames: [],
        dlcAddons: [],
        warning: 'No products found. Try using /by-id endpoint with a known product ID.',
        debugUrl: searchUrl
      };
    }

    const exchangeRates = await getExchangeRates();
    const currencyCode = currencyInfo[region.toUpperCase()]?.name || 'EUR';
    const exchangeRate = exchangeRates[currencyCode] || 1.0;
    const currencyData = currencyInfo[region.toUpperCase()] || currencyInfo['BE'];

    const processPromises = [];

    searchResults.each((index, element) => {
      processPromises.push((async () => {
        try {
          let productName = extractProductName(element, $);
          let productPrice = extractProductPrice(element, $);
          const productURL = extractProductUrl(element, $);
          let imageUrl = extractProductImage(element, $);
          
          const productId = extractProductId(productURL);

          console.log(`[PRODUCT ${index}] Name: "${productName}" | Price: "${productPrice}" | ID: ${productId}`);

          if (productName && productPrice) {
            if (region.toUpperCase() === 'BE') {
              productPrice = productPrice.replace(/\$/g, '€');
            }

            const rawPrice = parsePrice(productPrice);
            const priceInEur = rawPrice * exchangeRate;
            const highResImageUrl = upgradeImageUrl(imageUrl);

            const productObj = {
              index: index,
              name: productName,
              price: productPrice,
              rawPrice: rawPrice,
              priceInEur: priceInEur,
              currency: currencyData.symbol,
              currencyCode: currencyData.name,
              exchangeRate: exchangeRate,
              url: getProductUrl(productURL),
              imageUrl: highResImageUrl,
              region: region,
              productId: productId
            };

            if (productId) {
              try {
                const metadata = await fetchProductMetadata(productId, localeCode);
                if (metadata && metadata.imageUrl) {
                  productObj.imageUrl = upgradeImageUrl(metadata.imageUrl);
                  productObj.enriched = true;
                }
              } catch (err) {
                console.log(`[METADATA] Enrichment skipped for ${productId}`);
              }
            }

            resultArr.push(productObj);
          } else {
            console.warn(`[SKIPPED] Missing name or price at index ${index}`);
          }
        } catch (err) {
          console.error(`[PROCESS] Error processing result at index ${index}:`, err.message);
        }
      })());
    });

    await Promise.all(processPromises);

    // NEW: Rank and filter results
    let finalResults = resultArr;
    let baseGames = [];
    let dlcAddons = [];
    
    if (sortByRelevance && resultArr.length > 0) {
      const ranked = rankSearchResults(resultArr, searchString);
      
      if (filterDLC) {
        // Default: Return only base games, but keep all in separate field
        finalResults = ranked.baseGames;
        baseGames = ranked.baseGames;
        dlcAddons = ranked.dlcAddons;
        console.log(`[FILTERED] Showing ${baseGames.length} base games, hiding ${dlcAddons.length} DLC/add-ons`);
      } else {
        // If filtering disabled, return all but still ranked
        finalResults = ranked.all;
        baseGames = ranked.baseGames;
        dlcAddons = ranked.dlcAddons;
      }
    }

    const returnObject = {
      region: region,
      currency: currencyData.symbol,
      currencyCode: currencyData.name,
      exchangeRate: exchangeRate,
      searchUrl: searchUrl,
      searchResults: finalResults, // Filtered/ranked results
      baseGames: baseGames, // Separated base games
      dlcAddons: dlcAddons, // Separated DLC (user can access if needed)
      totalResults: resultArr.length,
      filteredCount: finalResults.length,
      cacheInfo: {
        productsCached: productCache.keys().length,
        cacheHitRate: `${((productCache.keys().length / (resultArr.length + 1)) * 100).toFixed(1)}%`
      }
    };

    return returnObject;

  } catch (error) {
    console.error('Error fetching from region', region, ':', error.message);
    return {
      region: region,
      currency: currencyInfo[region.toUpperCase()]?.symbol || '€',
      currencyCode: currencyInfo[region.toUpperCase()]?.name || 'EUR',
      searchResults: [],
      baseGames: [],
      dlcAddons: [],
      error: error.message
    };
  }
};

/**
 * Direct product lookup by Product ID
 */
const getProductByID = async (productId, region = 'BE') => {
  try {
    const localeCode = regionMap[region.toUpperCase()] || 'en-be';
    
    const metadata = await fetchProductMetadata(productId, localeCode);
    if (metadata) {
      return {
        region: region,
        product: metadata,
        source: 'metadata_api',
        imageUrl: upgradeImageUrl(metadata.imageUrl)
      };
    }

    const storeUrl = `https://store.playstation.com/${localeCode}/product/${productId}`;
    const response = await axios.get(storeUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 5000
    });

    const $ = cheerio.load(response.data);
    
    const priceElement = $('[data-qa*="price"]').first().text();
    const imageElement = $('img[data-qa*="hero-image"]').attr('src') || 
                         $('img[alt*="game"]').first().attr('src');

    const exchangeRates = await getExchangeRates();
    const currencyCode = currencyInfo[region.toUpperCase()]?.name || 'EUR';
    const exchangeRate = exchangeRates[currencyCode] || 1.0;

    return {
      region: region,
      product: {
        id: productId,
        price: priceElement,
        rawPrice: parsePrice(priceElement),
        imageUrl: upgradeImageUrl(imageElement)
      },
      source: 'store_page',
      priceInEur: parsePrice(priceElement) * exchangeRate
    };

  } catch (error) {
    console.error(`[PRODUCT_ID] Failed to fetch ${productId}:`, error.message);
    return {
      region: region,
      error: error.message,
      productId: productId
    };
  }
};

module.exports = {
  getProductInfo: getProductInfo,
  getProductByID: getProductByID,
  extractProductId: extractProductId,
  upgradeImageUrl: upgradeImageUrl
};
