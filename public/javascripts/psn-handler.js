/**
 * PSN Handler - Refactored version with region-specific support
 * Features:
 * - Region-specific CSS selectors
 * - Cross-region product matching
 * - Enhanced error handling
 * - Product ID enrichment
 */

const PSNHandler = (() => {
  // Region configuration with specific selectors
  const REGION_CONFIG = {
    us: {
      name: 'United States',
      domain: 'store.playstation.com',
      selectors: {
        productTitle: 'h1[data-testid="pdp-title"]',
        productPrice: '[data-testid="priceDisplay"]',
        productId: '[data-product-id]',
        productImage: 'img[data-testid="pdp-hero-image"]',
        productDescription: '[data-testid="pdp-description"]',
        productRating: '[data-testid="aggregated-rating"]'
      }
    },
    eu: {
      name: 'Europe',
      domain: 'store.playstation.com/en-*',
      selectors: {
        productTitle: 'h1.psw-product-title',
        productPrice: '.psw-price-display',
        productId: '[data-sku]',
        productImage: 'img.psw-product-image',
        productDescription: '.psw-product-description',
        productRating: '.psw-rating'
      }
    },
    jp: {
      name: 'Japan',
      domain: 'store.playstation.com/ja-jp',
      selectors: {
        productTitle: 'h1.product-title-jp',
        productPrice: '.price-jp',
        productId: '[data-product-code]',
        productImage: 'img.product-image-jp',
        productDescription: '.description-jp',
        productRating: '.rating-jp'
      }
    }
  };

  /**
   * Detect current region based on domain or configuration
   */
  const detectRegion = () => {
    const hostname = window.location.hostname;
    
    if (hostname.includes('store.playstation.com')) {
      const path = window.location.pathname;
      if (path.includes('/ja-jp/')) return 'jp';
      if (path.includes('/en-')) return 'eu';
      return 'us';
    }
    
    return 'us'; // Default to US
  };

  /**
   * Get selectors for current or specified region
   */
  const getRegionSelectors = (region = null) => {
    const targetRegion = region || detectRegion();
    return REGION_CONFIG[targetRegion] || REGION_CONFIG.us;
  };

  const getProductByID = async (productId, region = 'BE') => {
  try {
    const locale = regionMap[region.toUpperCase()] || 'en-be';
    const url = `https://store.playstation.com/${locale}/product/${productId}`;

    console.log(`[PRODUCT_ID] Fetching ${url}`);

    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 5000
    });

    const $ = cheerio.load(response.data);
    const priceText = $('[data-qa*="price"]').first().text().trim();

    // get exchange rate for this region
    const exchangeRates = await getExchangeRates();
    const currencyCode = currencyInfo[region.toUpperCase()]?.name || 'EUR';
    const rate = exchangeRates[currencyCode] || 1.0;

    const rawPrice = parsePrice(priceText);
    const priceInEur = rawPrice * rate;

    return {
      ok: true,
      region,
      productId,
      price: priceText,
      rawPrice,
      priceInEur
    };
  } catch (err) {
    console.error(`[PRODUCT_ID] Failed for ${productId} in ${region}:`, err.message);
    return { ok: false, region, productId, error: err.message };
  }
};
  
  /**
   * Extract product data from DOM using region-specific selectors
   */
  const extractProductData = (element = document, region = null) => {
    const config = getRegionSelectors(region);
    const selectors = config.selectors;
    
    try {
      const title = element.querySelector(selectors.productTitle)?.textContent?.trim();
      const priceElement = element.querySelector(selectors.productPrice);
      const price = priceElement?.textContent?.trim() || priceElement?.getAttribute('data-price');
      const productId = element.querySelector(selectors.productId)?.getAttribute('data-product-id') ||
                       element.querySelector(selectors.productId)?.getAttribute('data-sku') ||
                       element.querySelector(selectors.productId)?.getAttribute('data-product-code');
      const imageUrl = element.querySelector(selectors.productImage)?.src;
      const description = element.querySelector(selectors.productDescription)?.textContent?.trim();
      const rating = element.querySelector(selectors.productRating)?.textContent?.trim();

      return {
        title,
        price,
        productId: enrichProductId(productId, region),
        imageUrl,
        description,
        rating,
        region: config.name,
        detectedAt: new Date().toISOString()
      };
    } catch (error) {
      console.error(`[PSNHandler] Error extracting product data for region ${region}:`, error);
      throw new ProductExtractionError(
        `Failed to extract product data for region ${region}`,
        { originalError: error, region, timestamp: new Date().toISOString() }
      );
    }
  };

  /**
   * Enrich product ID with region and validation
   */
  const enrichProductId = (productId, region = null) => {
    if (!productId) {
      return null;
    }

    const targetRegion = region || detectRegion();
    const regionCode = {
      us: 'US',
      eu: 'EU',
      jp: 'JP'
    }[targetRegion] || 'UNKNOWN';

    return {
      raw: productId,
      enriched: `${regionCode}-${productId}`,
      region: targetRegion,
      validated: validateProductId(productId),
      checksum: generateChecksum(productId)
    };
  };

  /**
   * Validate product ID format
   */
  const validateProductId = (productId) => {
    if (!productId || typeof productId !== 'string') {
      return false;
    }
    // PSN product IDs are typically alphanumeric, 8-20 characters
    return /^[A-Z0-9]{8,20}$/i.test(productId.trim());
  };

  /**
   * Generate checksum for product ID integrity
   */
  const generateChecksum = (productId) => {
    if (!productId) return null;
    
    let checksum = 0;
    for (let i = 0; i < productId.length; i++) {
      checksum += productId.charCodeAt(i);
    }
    return checksum.toString(16);
  };

  /**
   * Cross-region product matching algorithm
   */
  const matchProductsCrossRegion = async (productData, targetRegions = ['us', 'eu', 'jp']) => {
    const matches = {
      exact: [],
      likely: [],
      potential: [],
      noMatch: false
    };

    try {
      for (const region of targetRegions) {
        if (region === productData.region) continue;

        // Attempt to fetch product from target region
        const regionData = await fetchProductFromRegion(productData, region);
        
        if (regionData) {
          const matchScore = calculateMatchScore(productData, regionData);
          
          if (matchScore >= 0.95) {
            matches.exact.push({
              region,
              data: regionData,
              confidence: matchScore
            });
          } else if (matchScore >= 0.80) {
            matches.likely.push({
              region,
              data: regionData,
              confidence: matchScore
            });
          } else if (matchScore >= 0.60) {
            matches.potential.push({
              region,
              data: regionData,
              confidence: matchScore
            });
          }
        }
      }

      if (matches.exact.length === 0 && matches.likely.length === 0 && matches.potential.length === 0) {
        matches.noMatch = true;
      }

      return matches;
    } catch (error) {
      console.error('[PSNHandler] Error in cross-region matching:', error);
      throw new CrossRegionMatchError(
        'Failed to perform cross-region product matching',
        { originalError: error, productData, timestamp: new Date().toISOString() }
      );
    }
  };

  /**
   * Fetch product data from a specific region
   */
  const fetchProductFromRegion = async (productData, targetRegion) => {
    try {
      // This is a placeholder - implement actual API call based on your backend
      const response = await fetch(`/api/psn/product/search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          query: productData.title,
          region: targetRegion,
          productId: productData.productId?.raw
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      console.warn(`[PSNHandler] Failed to fetch product from region ${targetRegion}:`, error);
      return null;
    }
  };

  /**
   * Calculate match score between two products
   */
  const calculateMatchScore = (product1, product2) => {
    let score = 0;
    let criteria = 0;

    // Title similarity (40% weight)
    if (product1.title && product2.title) {
      const titleSimilarity = calculateStringSimilarity(
        product1.title.toLowerCase(),
        product2.title.toLowerCase()
      );
      score += titleSimilarity * 0.40;
      criteria++;
    }

    // Price similarity (30% weight) - allow 20% variance
    if (product1.price && product2.price) {
      const price1 = parseFloat(product1.price);
      const price2 = parseFloat(product2.price);
      if (!isNaN(price1) && !isNaN(price2)) {
        const priceDiff = Math.abs(price1 - price2) / Math.max(price1, price2);
        const priceSimilarity = Math.max(0, 1 - priceDiff * 2);
        score += priceSimilarity * 0.30;
        criteria++;
      }
    }

    // Product ID similarity (30% weight)
    if (product1.productId?.raw && product2.productId?.raw) {
      const idSimilarity = product1.productId.raw === product2.productId.raw ? 1 : 
                          calculateStringSimilarity(product1.productId.raw, product2.productId.raw);
      score += idSimilarity * 0.30;
      criteria++;
    }

    return criteria > 0 ? score / criteria : 0;
  };

  /**
   * Calculate Levenshtein distance-based string similarity
   */
  const calculateStringSimilarity = (str1, str2) => {
    const maxLength = Math.max(str1.length, str2.length);
    if (maxLength === 0) return 1;

    const distance = levenshteinDistance(str1, str2);
    return (maxLength - distance) / maxLength;
  };

  /**
   * Levenshtein distance algorithm
   */
  const levenshteinDistance = (str1, str2) => {
    const matrix = [];

    for (let i = 0; i <= str2.length; i++) {
      matrix[i] = [i];
    }

    for (let j = 0; j <= str1.length; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= str2.length; i++) {
      for (let j = 1; j <= str1.length; j++) {
        if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }

    return matrix[str2.length][str1.length];
  };

  /**
   * Custom error classes
   */
  class PSNHandlerError extends Error {
    constructor(message, context = {}) {
      super(message);
      this.name = 'PSNHandlerError';
      this.context = context;
      this.timestamp = new Date().toISOString();
    }

    toJSON() {
      return {
        name: this.name,
        message: this.message,
        context: this.context,
        timestamp: this.timestamp
      };
    }
  }

  class ProductExtractionError extends PSNHandlerError {
    constructor(message, context = {}) {
      super(message, context);
      this.name = 'ProductExtractionError';
    }
  }

  class CrossRegionMatchError extends PSNHandlerError {
    constructor(message, context = {}) {
      super(message, context);
      this.name = 'CrossRegionMatchError';
    }
  }

  /**
   * Public API
   */
  return {
    // Configuration
    REGION_CONFIG,
    
    // Region detection and configuration
    detectRegion,
    getRegionSelectors,

    getProductInfo,
    getProductByID,
    
    // Product extraction
    extractProductData,
    enrichProductId,
    
    // Validation
    validateProductId,
    generateChecksum,
    
    // Cross-region operations
    matchProductsCrossRegion,
    fetchProductFromRegion,
    calculateMatchScore,
    calculateStringSimilarity,
    
    // Error classes
    PSNHandlerError,
    ProductExtractionError,
    CrossRegionMatchError,
    
    /**
     * Main handler function - comprehensive product extraction and analysis
     */
    async handleProduct(options = {}) {
      const {
        element = document,
        region = null,
        performCrossRegionMatch = false,
        targetRegions = ['us', 'eu', 'jp'],
        enrichData = true
      } = options;

      try {
        // Extract product data
        const productData = this.extractProductData(element, region);
        
        if (!productData.title) {
          throw new ProductExtractionError('Failed to extract product title', { productData });
        }

        let result = { productData };

        // Perform cross-region matching if requested
        if (performCrossRegionMatch) {
          result.crossRegionMatches = await this.matchProductsCrossRegion(
            productData,
            targetRegions
          );
        }

        // Enrich data if requested
        if (enrichData && !productData.productId) {
          result.productData.productId = this.enrichProductId(null, region);
        }

        result.success = true;
        result.processedAt = new Date().toISOString();

        return result;
      } catch (error) {
        console.error('[PSNHandler] Error handling product:', error);
        return {
          success: false,
          error: error instanceof PSNHandlerError ? error.toJSON() : {
            message: error.message,
            timestamp: new Date().toISOString()
          },
          processedAt: new Date().toISOString()
        };
      }
    },

    /**
     * Version information
     */
    version: '2.0.0',
    lastUpdated: '2026-01-11'
  };
})();

// Export for use in Node.js/CommonJS environments
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    PSNHandler: PSNHandler,
    getProductInfo: PSNHandler.getProductInfo,
    getProductByID: PSNHandler.getProductByID
  };
}
