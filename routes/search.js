var express = require('express');
const { getProductInfo, getProductByID } = require("../public/javascripts/psn-handler");
var router = express.Router();

const getSearchResults = async (req, res) => {
  try {
    const { query, region, filterDLC, sortByRelevance } = req.query;
    if (!query) {
      return res.status(400).json({ error: "Query parameter is required" });
    }

    const regionCode = region || 'BE'; // Default to Belgium
    
    // NEW: Parse filter options
    const options = {
      filterDLC: filterDLC !== 'false', // Default: true (filter DLC)
      sortByRelevance: sortByRelevance !== 'false' // Default: true (sort by relevance)
    };
    
    console.log(`[API] Search: "${query}" | Region: ${regionCode} | FilterDLC: ${options.filterDLC}`);
    
    const data = await getProductInfo(query, regionCode, options);
    res.status(200).json(data);

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

/**
 * Fallback endpoint: Search by Product ID instead of game title
 * Useful when title-based search fails across regions
 * 
 * Usage: GET /search-psn/by-id?productId=UP1234-CUSA01234_00-GAMECODE&region=JP
 */
const getProductById = async (req, res) => {
  try {
    const { productId, region } = req.query;
    
    if (!productId) {
      return res.status(400).json({ error: "productId parameter is required" });
    }

    const regionCode = region || 'BE'; // Default to Belgium
    const data = await getProductByID(productId, regionCode);
    res.status(200).json(data);

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

router.get('/', getSearchResults);
router.get('/by-id', getProductById);

module.exports = router;
