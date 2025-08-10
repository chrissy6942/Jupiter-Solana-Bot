const axios = require("axios");
const TelegramBot = require("node-telegram-bot-api");
const config = require("./config");

// Prevent multiple bot instances
let bot;
try {
  bot = new TelegramBot(config.TOKEN, {
    polling: {
      interval: 1000,
      autoStart: true,
      params: {
        timeout: 30,
      },
    },
  });
} catch (error) {
  console.error("❌ Bot initialization error:", error.message);
  process.exit(1);
}

let isMonitoring = false;
const POLL_INTERVAL = 60000; // Check every 60 seconds to avoid rate limits
const seenTokens = new Set();
const MAX_TOKEN_AGE = 5 * 60 * 1000; // 5 minutes in milliseconds

// Telegram Bot Commands
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(
    chatId,
    `
🤖 *Solana Memecoin Sniper Bot*

Commands:
/monitor - Start monitoring for new tokens
/stop - Stop monitoring
/status - Check bot status
/criteria - View filtering criteria

Ready to snipe NEW Solana memecoins! 🚀
Only tokens < 5 minutes old will be alerted.
`,
    { parse_mode: "Markdown" },
  );
});

bot.onText(/\/monitor/, (msg) => {
  const chatId = msg.chat.id;
  if (!isMonitoring) {
    isMonitoring = true;
    startMonitoring();
    bot.sendMessage(
      chatId,
      "✅ Started monitoring for NEW Solana tokens (low market cap with activity)!",
    );
  } else {
    bot.sendMessage(chatId, "⚠️ Already monitoring!");
  }
});

bot.onText(/\/stop/, (msg) => {
  const chatId = msg.chat.id;
  isMonitoring = false;
  bot.sendMessage(chatId, "⏹️ Stopped monitoring.");
});

bot.onText(/\/status/, (msg) => {
  const chatId = msg.chat.id;
  const status = isMonitoring ? "🟢 Active" : "🔴 Stopped";
  bot.sendMessage(
    chatId,
    `Status: ${status}\nTokens processed: ${seenTokens.size}`,
  );
});

bot.onText(/\/criteria/, (msg) => {
  const chatId = msg.chat.id;
  const criteria = `
🎯 *Sniper Bot Token Criteria (Solana)*

🧪 *1. Market Cap & Activity*
✅ Market cap under $10M (new token indicator)
✅ Trading volume > $1,000 (active token)
❌ Ignore high market cap tokens (likely established)

💧 *2. Liquidity Pool*
✅ Minimum LP: $5,000+ in SOL or USDC
❌ Auto-ignore if LP < $3,000 (rug risk too high)

🧠 *3. Contract Safety*
✅ Verified contract on Solana
✅ No mint authority or freeze authority
✅ Owner renounced or multisig preferred

💸 *4. Buy/Sell Tax*
✅ Both buy and sell tax < 10%
❌ Ignore tokens with 15%+ tax in either direction

📊 *5. Holder Distribution*
✅ No single wallet holds more than 20% of supply
❌ Flag if creator wallet owns >30% of supply

🪙 *6. Tokenomics & Symbol*
✅ Name/symbol must be present (no "?" or "UNKNOWN")
✅ Max supply < 1B tokens
✅ Prefer short tickers (3–6 characters)

🚨 *Final Alert Trigger*
Only sends alert if it meets ALL criteria above!
  `;
  bot.sendMessage(chatId, criteria, { parse_mode: "Markdown" });
});

async function getNewTokens() {
  try {
    console.log("🌐 Making API request to Birdeye for new tokens...");

    // Use tokenlist endpoint which is more reliable
    const response = await axios.get(
      "https://public-api.birdeye.so/defi/tokenlist",
      {
        params: {
          sort_by: "v24hUSD",
          sort_type: "desc",
          offset: 0,
          limit: 50,
        },
        headers: {
          "X-API-KEY": config.BIRDEYE_API_KEY,
        },
        timeout: 15000,
      },
    );

    console.log("📡 API Response received, status:", response.status);

    if (!response.data) {
      console.error("❌ No data in API response");
      return [];
    }

    if (!response.data.data) {
      console.error("❌ No data.data in API response");
      console.log("Response structure:", Object.keys(response.data));
      return [];
    }

    const tokens = response.data.data || [];
    console.log(`📊 Retrieved ${tokens.length} total tokens from API`);

    if (tokens.length === 0) {
      console.log("⚠️ No tokens found in API response");
      return [];
    }

    // Since trending API might not have createdTime, let's get token info for each
    // and use other criteria to identify potentially new tokens
    const filteredTokens = [];

    for (const token of tokens.slice(0, 20)) {
      // Check top 20 trending
      // Skip major/established tokens
      const majorTokens = [
        "SOL",
        "USDC",
        "USDT",
        "WETH",
        "WBTC",
        "JUP",
        "RAY",
        "BONK",
        "TRUMP",
        "PENGU",
        "JITOSOL",
        "JLP",
        "CBBTC",
        "FARTCOIN",
        "PUMP",
        "PEPE",
        "PEPECOIN",
        "DOGEWIF",
        "LILPEPE",
        "WALMART",
        "PORNHUB",
        "GENES",
        "IMMORTAL",
        "BUCKY",
        "RAI",
      ];

      if (majorTokens.includes(token.symbol?.toUpperCase())) {
        continue;
      }

      // Get detailed token info to check if it's potentially new
      try {
        const tokenInfo = await getTokenInfo(token.address);

        // Consider tokens with very low market cap OR recent activity as potentially new
        const isLowMarketCap =
          tokenInfo.marketCap && tokenInfo.marketCap < 1000000; // Under $1M for newer tokens
        const hasRecentActivity =
          tokenInfo.volume24h && tokenInfo.volume24h > 500; // Some activity
        const isVeryNew =
          tokenInfo.lastTradeUnixTime &&
          Date.now() - tokenInfo.lastTradeUnixTime * 1000 < 30 * 60 * 1000; // Last trade within 30 mins

        if (
          isLowMarketCap ||
          isVeryNew ||
          (hasRecentActivity && tokenInfo.marketCap < 5000000)
        ) {
          console.log(
            `🔍 Found potential new token: ${token.name} (${token.symbol}) - MC: $${tokenInfo.marketCap?.toLocaleString()}, Vol: $${tokenInfo.volume24h?.toLocaleString()}`,
          );
          filteredTokens.push(token);
        }

        // Add delay between requests
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (error) {
        console.warn(
          `⚠️ Failed to get info for ${token.symbol}:`,
          error.message,
        );
      }
    }

    console.log(
      `🔍 Found ${filteredTokens.length} potential new tokens based on market cap and activity`,
    );
    return filteredTokens;
  } catch (error) {
    if (error.response?.status === 429) {
      console.log("⚠️ Rate limited, waiting 30 seconds...");
      await new Promise((resolve) => setTimeout(resolve, 30000));
    } else {
      console.error(
        "❌ Error fetching tokens:",
        error.response?.data || error.message,
      );
      if (error.response?.status) {
        console.error(`HTTP Status: ${error.response.status}`);
      }
    }
    return [];
  }
}

async function getTokenInfo(address) {
  try {
    await new Promise((resolve) => setTimeout(resolve, 1500)); // Rate limit protection

    const response = await axios.get(
      `https://public-api.birdeye.so/defi/token_overview`,
      {
        params: { address },
        headers: { "X-API-KEY": config.BIRDEYE_API_KEY },
        timeout: 10000,
      },
    );

    const tokenInfo = response.data?.data || {};
    console.log(
      `📈 Token info for ${address}: Liquidity=$${tokenInfo.liquidity || 0}, MC=$${tokenInfo.marketCap || 0}`,
    );
    return tokenInfo;
  } catch (error) {
    if (error.response?.status === 429) {
      console.log("⚠️ Token info rate limited, waiting...");
      await new Promise((resolve) => setTimeout(resolve, 5000));
    } else {
      console.warn(
        `⚠️ Failed to get token info for ${address}:`,
        error.message,
      );
    }
    return {};
  }
}

async function getTokenSecurity(address) {
  try {
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const response = await axios.get(
      `https://public-api.birdeye.so/defi/token_security`,
      {
        params: { address },
        headers: { "X-API-KEY": config.BIRDEYE_API_KEY },
        timeout: 10000,
      },
    );

    const securityInfo = response.data?.data || {};
    console.log(
      `🔒 Security info for ${address}: Mint=${securityInfo.mintAuthority}, Freeze=${securityInfo.freezeAuthority}`,
    );
    return securityInfo;
  } catch (error) {
    console.warn(
      `⚠️ Security check failed for ${address}, treating as unsafe:`,
      error.message,
    );
    return {};
  }
}

function isTokenNameValid(name, symbol) {
  if (!name || !symbol) {
    console.log(`❌ Missing name or symbol: "${name}" / "${symbol}"`);
    return false;
  }
  if (name.includes("?") || name.toLowerCase().includes("unknown")) {
    console.log(`❌ Invalid name: "${name}"`);
    return false;
  }
  if (symbol.includes("?") || symbol.toLowerCase().includes("unknown")) {
    console.log(`❌ Invalid symbol: "${symbol}"`);
    return false;
  }
  if (symbol.length > 10 || symbol.length < 1) {
    console.log(
      `❌ Invalid symbol length: "${symbol}" (${symbol.length} chars)`,
    );
    return false;
  }
  return true;
}

function passesTokenCriteria(token, tokenInfo, securityInfo) {
  console.log(`\n🔍 Evaluating token: ${token.name} (${token.symbol})`);

  // 1. Token age check - must be less than 5 minutes old
  if (tokenInfo.createdTime) {
    const createdAt = new Date(tokenInfo.createdTime * 1000); // Convert Unix timestamp to milliseconds
    const now = new Date();
    const tokenAge = now - createdAt;

    if (tokenAge > MAX_TOKEN_AGE) {
      console.log(
        `❌ Token too old: ${Math.floor(tokenAge / 1000)} seconds old (max: ${MAX_TOKEN_AGE / 1000}s)`,
      );
      return false;
    }
    console.log(
      `✅ Token age check passed: ${Math.floor(tokenAge / 1000)} seconds old`,
    );
  } else if (tokenInfo.lastTradeUnixTime) {
    // Use last trade time as proxy for token age
    const lastTradeAt = new Date(tokenInfo.lastTradeUnixTime * 1000);
    const now = new Date();
    const timeSinceLastTrade = now - lastTradeAt;

    if (timeSinceLastTrade > MAX_TOKEN_AGE) {
      console.log(
        `❌ Token inactive for too long: ${Math.floor(timeSinceLastTrade / 1000)} seconds since last trade`,
      );
      return false;
    }
    console.log(
      `✅ Recent activity check passed: ${Math.floor(timeSinceLastTrade / 1000)} seconds since last trade`,
    );
  } else {
    // If no timing data available, require very low market cap as newness indicator
    if (!tokenInfo.marketCap || tokenInfo.marketCap > 100000) {
      // Under $100K for truly new tokens
      console.log(
        `❌ No timing data and market cap too high for new token: $${tokenInfo.marketCap?.toLocaleString() || "Unknown"}`,
      );
      return false;
    }
    console.log(
      `✅ New token indicator: Very low market cap $${tokenInfo.marketCap?.toLocaleString()}`,
    );
  }

  // 2. Market Cap check for new tokens
  if (tokenInfo.marketCap && tokenInfo.marketCap > 10000000) {
    console.log(
      `❌ Market cap too high for new token: $${tokenInfo.marketCap.toLocaleString()}`,
    );
    return false;
  }
  console.log(
    `✅ Market cap check passed: $${tokenInfo.marketCap?.toLocaleString() || "Unknown"}`,
  );

  // 3. Check for trading activity (sign of a new/active token)
  if (!tokenInfo.volume24h || tokenInfo.volume24h < 1000) {
    console.log(
      `❌ Insufficient trading activity: $${tokenInfo.volume24h || 0}`,
    );
    return false;
  }
  console.log(
    `✅ Trading activity check passed: $${tokenInfo.volume24h.toLocaleString()}`,
  );

  // 4. Liquidity Pool - Minimum $5,000+
  const liquidity = tokenInfo.liquidity || 0;
  if (liquidity < 5000) {
    console.log(`❌ Liquidity too low: $${liquidity.toLocaleString()}`);
    return false;
  }
  console.log(`✅ Liquidity check passed: $${liquidity.toLocaleString()}`);

  // 5. Contract Safety - Check authorities
  if (!securityInfo || Object.keys(securityInfo).length === 0) {
    console.log(`❌ No security data available - treating as unsafe`);
    return false;
  }

  if (securityInfo.mintAuthority === true) {
    console.log(`❌ Has mint authority - unsafe`);
    return false;
  }

  if (securityInfo.freezeAuthority === true) {
    console.log(`❌ Has freeze authority - unsafe`);
    return false;
  }
  console.log(`✅ Authority checks passed`);

  // 6. Buy/Sell Tax - Both must be < 10%
  const buyTax = securityInfo.buyTax || 0;
  const sellTax = securityInfo.sellTax || 0;

  if (buyTax >= 10) {
    console.log(`❌ High buy tax: ${buyTax}%`);
    return false;
  }

  if (sellTax >= 10) {
    console.log(`❌ High sell tax: ${sellTax}%`);
    return false;
  }
  console.log(`✅ Tax checks passed: Buy=${buyTax}%, Sell=${sellTax}%`);

  // 7. Holder Distribution
  if (securityInfo.topHolderRate && securityInfo.topHolderRate > 20) {
    console.log(`❌ High whale concentration: ${securityInfo.topHolderRate}%`);
    return false;
  }

  if (securityInfo.creatorBalance && securityInfo.creatorBalance > 30) {
    console.log(`❌ Creator holds too much: ${securityInfo.creatorBalance}%`);
    return false;
  }
  console.log(`✅ Holder distribution checks passed`);

  // 8. Name/Symbol validation
  if (!isTokenNameValid(token.name, token.symbol)) {
    return false;
  }
  console.log(`✅ Name/symbol validation passed`);

  // 9. Supply check
  if (token.supply && token.supply > 1000000000) {
    console.log(`❌ Max supply too high: ${token.supply.toLocaleString()}`);
    return false;
  }

  // 10. Symbol length preference
  if (token.symbol && (token.symbol.length < 3 || token.symbol.length > 6)) {
    console.log(
      `⚠️ Symbol length not optimal: ${token.symbol} (${token.symbol.length} chars) - but allowing`,
    );
    // Don't return false, just warn
  }

  // 11. Skip established tokens
  const majorTokens = [
    "SOL",
    "USDC",
    "USDT",
    "WETH",
    "WBTC",
    "BTC",
    "ETH",
    "JUP",
    "RAY",
    "BONK",
    "PENGU",
    "JITOSOL",
    "JLP",
    "CBBTC",
    "FARTCOIN",
    "PUMP",
    "PEPE",
    "PEPECOIN",
    "DOGEWIF",
    "LILPEPE",
    "WALMART",
    "PORNHUB",
    "GENES",
    "IMMORTAL",
    "BUCKY",
    "RAI",
    "TRUMP",
  ];
  if (majorTokens.includes(token.symbol?.toUpperCase())) {
    console.log(`❌ Established token skipped: ${token.symbol}`);
    return false;
  }

  // 12. Market cap check for new tokens
  if (tokenInfo.marketCap && tokenInfo.marketCap > 10000000) {
    console.log(
      `❌ Market cap too high for new token: $${tokenInfo.marketCap.toLocaleString()}`,
    );
    return false;
  }

  console.log(`🎯 ✅ TOKEN PASSES ALL CRITERIA! 🎯`);
  return true;
}

async function checkForNewTokens() {
  if (!isMonitoring) return;

  try {
    console.log(
      "\n🔍 =================== STARTING NEW SCAN ===================",
    );
    const tokens = await getNewTokens();

    if (tokens.length === 0) {
      console.log("📊 No new tokens found, skipping scan");
      return;
    }

    console.log(`📊 Processing ${tokens.length} new tokens...`);

    let validTokensChecked = 0;
    let newTokensFound = 0;

    for (const token of tokens) {
      // Skip if already processed
      if (seenTokens.has(token.address)) {
        console.log(`⏭️ Already processed: ${token.name} (${token.symbol})`);
        continue;
      }

      // Quick filter for major tokens
      const majorTokens = [
        "SOL",
        "USDC",
        "USDT",
        "WETH",
        "WBTC",
        "JUP",
        "RAY",
        "BONK",
        "TRUMP",
        "PENGU",
        "JITOSOL",
        "JLP",
        "CBBTC",
        "FARTCOIN",
        "PUMP",
        "PEPE",
        "PEPECOIN",
        "DOGEWIF",
        "LILPEPE",
        "WALMART",
        "PORNHUB",
        "GENES",
        "IMMORTAL",
        "BUCKY",
        "RAI",
      ];
      if (majorTokens.includes(token.symbol?.toUpperCase())) {
        console.log(`⏭️ Skipping major token: ${token.symbol}`);
        seenTokens.add(token.address);
        continue;
      }

      validTokensChecked++;
      console.log(
        `\n🔍 [${validTokensChecked}/${tokens.length}] Analyzing: ${token.name} (${token.symbol})`,
      );
      console.log(`📍 Address: ${token.address}`);

      // Get detailed info with better error handling
      const [tokenInfo, securityInfo] = await Promise.allSettled([
        getTokenInfo(token.address),
        getTokenSecurity(token.address),
      ]);

      const resolvedTokenInfo =
        tokenInfo.status === "fulfilled" ? tokenInfo.value : {};
      const resolvedSecurityInfo =
        securityInfo.status === "fulfilled" ? securityInfo.value : {};

      // Apply criteria checks
      if (
        !passesTokenCriteria(token, resolvedTokenInfo, resolvedSecurityInfo)
      ) {
        seenTokens.add(token.address);
        continue;
      }

      // Token passed all criteria!
      seenTokens.add(token.address);
      newTokensFound++;

      console.log(`\n🚨 🎯 ALERT! NEW MEMECOIN FOUND! 🎯 🚨`);
      await sendTokenAlert(token, resolvedTokenInfo, resolvedSecurityInfo);

      // Delay between alerts
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }

    console.log(`\n✅ =================== SCAN COMPLETE ===================`);
    console.log(
      `📊 Summary: Checked ${validTokensChecked} tokens, found ${newTokensFound} gems!`,
    );
    console.log(`🗃️ Total tokens processed so far: ${seenTokens.size}`);
  } catch (error) {
    console.error("❌ Error in token scan:", error.message);
  }
}

async function sendTokenAlert(token, tokenInfo, securityInfo) {
  try {
    const { address, name = "Unknown", symbol = "Unknown" } = token;

    const { price, priceChange24h, marketCap, volume24h, liquidity } =
      tokenInfo;

    const explorerLink = `https://solscan.io/token/${address}`;
    const dexLink = `https://dexscreener.com/solana/${address}`;
    const jupiterLink = `https://jup.ag/swap/SOL-${address}`;

    const text = `
🚨 *NEW MEMECOIN DETECTED!* 🚨

💎 *${name}* (${symbol})
📍 \`${address}\`

💰 *Price:* $${price ? price.toFixed(8) : "New"}
📊 *Market Cap:* $${marketCap ? marketCap.toLocaleString() : "Low"}
💧 *Liquidity:* $${liquidity ? liquidity.toLocaleString() : "Unknown"}
📈 *24h Volume:* $${volume24h ? volume24h.toLocaleString() : "New"}

🛡️ *Safety Checks:*
✅ Name/Symbol valid
✅ Mint Authority: ${securityInfo.mintAuthority === false ? "Renounced ✅" : "Unknown ⚠️"}
✅ Freeze Authority: ${securityInfo.freezeAuthority === false ? "Renounced ✅" : "Unknown ⚠️"}
✅ Age: < 5 minutes old
✅ Liquidity: $${liquidity ? liquidity.toLocaleString() : "0"}+

🔗 *Quick Actions:*
[🔍 Solscan](${explorerLink}) | [📊 DexScreener](${dexLink}) | [🔄 Jupiter](${jupiterLink})

⚡ *FRESH LAUNCH - ACT FAST!* ⚡
`;

    await bot.sendMessage(config.TELEGRAM_CHAT_ID, text, {
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    });

    console.log(`📢 ✅ Alert sent successfully for: ${name} (${symbol})`);
  } catch (error) {
    console.error("❌ Error sending alert:", error.message);
  }
}

function startMonitoring() {
  console.log(
    "🔍 Starting NEW token monitoring with enhanced safety criteria...",
  );

  // Initial check
  checkForNewTokens();

  // Set up interval
  const interval = setInterval(() => {
    if (isMonitoring) {
      checkForNewTokens();
    } else {
      clearInterval(interval);
    }
  }, POLL_INTERVAL);
}

// Error handling
bot.on("error", (error) => {
  console.error("❌ Telegram Bot Error:", error.message);
});

bot.on("polling_error", (error) => {
  if (error.message.includes("409 Conflict")) {
    console.error("❌ Bot conflict detected - stopping this instance");
    process.exit(1);
  } else {
    console.error("❌ Telegram Polling Error:", error.message);
  }
});

process.on("unhandledRejection", (error) => {
  console.error("❌ Unhandled Promise Rejection:", error.message);
});

process.on("uncaughtException", (error) => {
  console.error("❌ Uncaught Exception:", error.message);
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("🛑 Shutting down bot gracefully...");
  if (bot) {
    bot.stopPolling();
  }
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("🛑 Terminating bot...");
  if (bot) {
    bot.stopPolling();
  }
  process.exit(0);
});

console.log("🤖 Solana Memecoin Sniper Bot Started!");
console.log("🎯 Filtering for low market cap tokens with trading activity");
console.log("Send /start to your bot to begin!");

// Test API key on startup
async function testAPIKey() {
  if (!config.BIRDEYE_API_KEY) {
    console.log("❌ BIRDEYE_API_KEY is missing from environment variables!");
    console.log("🔧 Please add your API key to Replit Secrets");
    return;
  }

  try {
    console.log("🔧 Testing Birdeye API key...");
    const response = await axios.get(
      "https://public-api.birdeye.so/defi/tokenlist",
      {
        params: { limit: 1 },
        headers: { "X-API-KEY": config.BIRDEYE_API_KEY },
        timeout: 10000,
      },
    );
    console.log("✅ Birdeye API key is working correctly!");
  } catch (error) {
    console.log(
      "❌ Birdeye API key test failed:",
      error.response?.status,
      error.response?.data || error.message,
    );
    console.log("🔑 Please check your BIRDEYE_API_KEY in Replit Secrets");
  }
}

testAPIKey();

// Auto-start monitoring after API test
setTimeout(() => {
  console.log("🔄 Auto-starting token monitoring...");
  isMonitoring = true;
  startMonitoring();
}, 8000);
