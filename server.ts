import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import axios, { AxiosRequestConfig } from 'axios';
import OAuth from 'oauth-1.0a';
import crypto from 'crypto';
import qs from 'querystring';
import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';

dotenv.config(); // ✅ This must be BEFORE using process.env


const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

console.log('🔧 Initializing E*TRADE OAuth server...');

const oauth = new OAuth({
  consumer: {
    key: process.env.CONSUMER_KEY_PROD || '',
    secret: process.env.CONSUMER_SECRET_PROD || '',
  },
  signature_method: 'HMAC-SHA1',
  hash_function(baseString, key) {
    return crypto.createHmac('sha1', key).update(baseString).digest('base64');
  },
});

const app = express();
const PORT = 4000;
app.use(cors({
  origin: 'https://dashboard-prod-green.vercel.app', // Only the domain, no path
  methods: ['GET', 'POST'],
  credentials: true, // optional, if using cookies
}));
app.use(express.json());

app.get('/', (_req, res) => {
  res.send('Dashboard server is running.');
});

console.log('🔐 Using key:', process.env.CONSUMER_KEY_PROD);
console.log('🔐 Using secret:', process.env.CONSUMER_SECRET_PROD);


app.get('/api/initiate-oauth', async (_req: Request, res: Response): Promise<any> => {
  console.log('➡️  /api/initiate-oauth route triggered');

  const url = 'https://api.etrade.com/oauth/request_token?format=json';
  const request_data = {
    url,
    method: 'GET' as const,
    data: {
      oauth_callback: 'oob',
    },
  };

  const authHeader = oauth.toHeader(oauth.authorize(request_data));

  const config: AxiosRequestConfig = {
    headers: {
      ...authHeader,
    },
  };

  console.log('📤 Sending initiate-oauth request to E*TRADE...');
  // console.log('🛠 OAuth Headers:', config.headers);

  try {
    const response = await axios.get(url, config);
    console.log('initiate-oauth response', response.data);

    const parsed = qs.parse(response.data);
    console.log('initiate-oauth response parsed', parsed);

    return res.json({
      oauth_token: parsed.oauth_token,
      oauth_token_secret: parsed.oauth_token_secret,
      auth_url: `https://us.etrade.com/e/t/etws/authorize?key=${process.env.CONSUMER_KEY_PROD}&token=${parsed.oauth_token}`,
    });
  } catch (err: any) {
  console.error('❌ Error during initiate-oauth:');

  if (err.response) {
    console.error('Status:', err.response.status);
    console.error('Headers:', err.response.headers);
    console.error('Body:', err.response.data);
  } else if (err.request) {
    console.error('No response received:', err.request);
  } else {
    console.error('Error setting up request:', err.message);
  }

  return res.status(500).json({ error: 'OAuth request failed', details: err.message });
}

});

// In-memory token store (not persisted across restarts)
let storedAccessToken: string;
let storedAccessTokenSecret: string;

app.post('/api/execute-oauth', async (req: Request, res: Response): Promise<any> => {
  const { oauth_token, oauth_token_secret, oauth_verifier } = req.body;

  if (!oauth_token || !oauth_token_secret || !oauth_verifier) {
    return res.status(400).json({
      authenticated: false,
      error: 'Missing required fields'
    });
  }

  const accessTokenUrl = 'https://api.etrade.com/oauth/access_token';

  try {
    // Step 1: Exchange verifier for access token
    const request_data = {
      url: accessTokenUrl,
      method: 'GET' as const,
      data: { oauth_verifier },
    };

    const accessHeader = oauth.toHeader(
      oauth.authorize(request_data, {
        key: oauth_token,
        secret: oauth_token_secret,
      })
    );

    console.log('🔁 Requesting access token...');
    const accessResponse = await axios.get(accessTokenUrl, {
      headers: { ...accessHeader },
    });

    const rawParsed = qs.parse(accessResponse.data);
    const access_token = decodeURIComponent(rawParsed.oauth_token as string);
    const access_token_secret = decodeURIComponent(rawParsed.oauth_token_secret as string);

    // ✅ Store for later use (in-memory)
    storedAccessToken = access_token;
    storedAccessTokenSecret = access_token_secret;

    console.log('✅ Access token and secret stored in memory...');

    return res.json({
      authenticated: true,
    });
  } catch (err: any) {
    console.error('❌ Error:', err.response?.data || err.message);
    return res.status(500).json({
      authenticated: false,
      error: 'Failed to get access token'
    });
  }
});


app.get('/api/fetch-sp500-quotes', async (req: Request, res: Response): Promise<any> => {
  console.log(`📡 fetch-sp500-quotes API started`);

  try {
    const tickersPath = path.join(__dirname, 'sp500_tickers.json');
    const tickers = JSON.parse(fs.readFileSync(tickersPath, 'utf-8')).sp500_tickers;
    console.log(`📦 Loaded ${tickers.length} tickers`);

    const chunkArray = (arr: string[], size: number) =>
      Array.from({ length: Math.ceil(arr.length / size) }, (_, i) =>
        arr.slice(i * size, i * size + size)
      );

    const chunks = chunkArray(tickers, 50);
    console.log(`📊 Divided into ${chunks.length} chunks of up to 50`);

    const seenSymbols = new Set();
    const results = await Promise.all(
      chunks.map(async (batch, index) => {
        const symbols = batch.join(',');
        const quoteUrl = `https://apisb.etrade.com/v1/market/quote/${symbols}.json?overrideSymbolCount=true`;

        const quoteRequest = {
          url: quoteUrl,
          method: 'GET' as const,
        };

        const quoteHeader = oauth.toHeader(
          oauth.authorize(quoteRequest, {
            key: storedAccessToken,
            secret: storedAccessTokenSecret,
          })
        );

        console.log(`📡 Fetching chunk ${index + 1}: ${symbols}`);

        try {
          const response = await axios.get(quoteUrl, {
            headers: { ...quoteHeader },
          });

          console.log(`✅ Chunk ${index + 1} success`);

          const quotes = response.data.QuoteResponse?.QuoteData || [];

          const withNewHighs = quotes.map((q: any) => {
            const all = q.All || {};
            const product = q.Product || {};
            const symbol = product.symbol;
            const lastTrade = all.lastTrade;
            const week52High = all.high52;

            if (!symbol || lastTrade === undefined || week52High === undefined) {
              return null;
            }

            if (seenSymbols.has(symbol)) {
              return null;
            }
            seenSymbols.add(symbol);

            const isNewHigh = lastTrade >= week52High;

            if (isNewHigh) {
              console.log(`🚀 NEW HIGH: ${symbol} — lastTrade: ${lastTrade}, 52wHigh: ${week52High}`);
            }

            return {
              companyName: all.companyName || '',
              symbol,
              ask: all.ask,
              askSize: all.askSize,
              bid: all.bid,
              bidSize: all.bidSize,
              high52: all.high52,
              low52: all.low52,
              averageVolume: all.averageVolume,
              price: lastTrade,
              growth: all.high52 && lastTrade ? (((lastTrade - all.low52) / all.low52) * 100).toFixed(2) : null,
              industry: all.industry || '',
              isNewHigh,
            };
          }).filter(Boolean);

          return withNewHighs;
        } catch (error) {
          console.error(`❌ Error fetching chunk ${index + 1}:`, error);
          return null;
        }
      })
    );
    const combinedQuotes = results.flat().filter(Boolean);
    let historicalData = null;

    // Deduplicate by symbol
    const uniqueQuotesMap = new Map();
    for (const quote of combinedQuotes) {
      if (!uniqueQuotesMap.has(quote.symbol)) {
        uniqueQuotesMap.set(quote.symbol, quote);
      }
    }
    const uniqueQuotes = Array.from(uniqueQuotesMap.values());

    if (uniqueQuotes.length > 0) {
      try {
        const response = await axios.post('https://dashboard-server-prod.vercel.app/api/add-todays-highs', {
          highs: uniqueQuotes,
        });
        console.log(`📬 Sent ${uniqueQuotes.length} new highs to /api/add-todays-highs`);
        console.log('🧾 Supabase response:', response.data);

        // ✅ After storing new highs, fetch historical data
        const response2 = await axios.get('https://dashboard-server-prod.vercel.app/api/get-historical-data');
        console.log('📊 Historical data fetch triggered for new highs.', response2.status);
        historicalData = response2.data;
      } catch (err) {
        console.error('❌ Failed to call /api/add-todays-highs or /api/get-historical-data:');
      }
    } else {
      console.log('ℹ️ No new highs found to send.');
    }

    try {
  const formattedDate = new Date().toLocaleString('en-US', {
    month: '2-digit',
    day: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'America/New_York',
  }) + ' EST';

  await axios.post('https://dashboard-server-prod.vercel.app/api/pull-times', {
    timestamp: formattedDate
  });

  console.log(`🕓 Pull time recorded as: ${formattedDate}`);
} catch (err) {
  console.error('❌ Failed to send pull time to /api/pull-times:');
}


    console.log(`🎯 Fetched quotes from ${combinedQuotes.length} stocks across ${chunks.length} chunks`);

return res.json(historicalData);  
} catch (err: any) {
    console.error('❌ Error fetching quotes:', err.response?.data || err.message);
    return res.status(500).json({ error: 'Failed to fetch quotes' });
  }
});


app.post('/api/add-todays-highs', async (req: Request, res: Response): Promise<any> => {
  const { highs } = req.body;

  if (!Array.isArray(highs) || highs.length === 0) {
    return res.status(400).json({ error: 'No valid highs provided' });
  }

  try {
    const { data, error } = await supabase
      .from('newHighs')
      .insert(highs);

    if (error) {
      console.error('❌ Supabase insert error:', error);
      return res.status(500).json({ error: 'Failed to insert into Supabase' });
    }

    console.log(`✅ Inserted new high records into Supabase`);
    res.json({ message: 'Inserted successfully' });
  } catch (err: any) {
    console.error('❌ Unexpected error inserting to Supabase:', err.message);
    res.status(500).json({ error: 'Unexpected error' });
  }
});

app.get('/api/get-historical-data', async (req: Request, res: Response): Promise<any> => {
  console.log(`📡 get-historical-data API started`);

  try {

    const { data, error } = await supabase
      .from('newHighs')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('❌ Supabase error:', error.message);
      return res.status(500).json({ error: error.message });
    }

    console.log(`📦 Retrieved ${data.length} newHighs records:`);
    data.forEach((entry, index) => {
      console.log(`${index + 1}. ${entry.symbol} — Price: ${entry.price}, High52: ${entry.high52}`);
    });

    return res.status(200).json({ highs: data });
  } catch (err: any) {
    console.error('❌ Unexpected error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch newHighs' });
  }
});

app.post('/api/pull-times', async (req: Request, res: Response): Promise<any> => {
  const { timestamp } = req.body;

  if (!timestamp) {
    return res.status(400).json({ error: 'Missing timestamp' });
  }

  try {
    const { data, error } = await supabase
      .from('pullTimes')
      .insert([{ pullTime: timestamp }]);

    if (error) throw error;

    console.log(`📥 Saved pull time to Supabase: ${timestamp}`);
    res.status(200).json({ success: true });
  } catch (err: any) {
    console.error('❌ Error inserting into pullTimes:', err.message);
    res.status(500).json({ error: 'Failed to save timestamp' });
  }
});

app.post('/api/set-pull-time', async (_req: Request, res: Response): Promise<any> => {
  try {
    // Insert current timestamp
    // Get the latest entry
    const { data, error: fetchError } = await supabase
      .from('pullTimes')
      .select('pullTime')
      .order('pullTime', { ascending: false })
      .limit(1)
      .single();

    if (fetchError) {
      console.error('❌ Fetch failed:', fetchError.message);
      return res.status(500).json({ error: fetchError.message });
    }

    const latest = new Date(data.pullTime);
    const formatted = latest.toLocaleString('en-US', {
      month: '2-digit',
      day: '2-digit',
      year: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'America/New_York',
    }) + ' EST';

    console.log('set-pull-time api call response', formatted)
    return res.status(200).json({ formatted });
  } catch (err) {
    console.error('❌ Unexpected error:', err);
    return res.status(500).json({ error: 'Unexpected server error' });
  }
});



// app.post('/api/execute-oauth', async (req: Request, res: Response) => {
//   const { oauth_token, oauth_token_secret, oauth_verifier } = req.body;

//   if (!oauth_token || !oauth_token_secret || !oauth_verifier) {
//     return res.status(400).json({ error: 'Missing required fields' });
//   }

//   const accessTokenUrl = 'https://api.etrade.com/oauth/access_token';

//   try {
//     // Step 1: Exchange verifier for access token
//     const request_data = {
//       url: accessTokenUrl,
//       method: 'GET' as const,
//       data: { oauth_verifier },
//     };

//     const accessHeader = oauth.toHeader(
//       oauth.authorize(request_data, {
//         key: oauth_token,
//         secret: oauth_token_secret,
//       })
//     );

//     console.log('🔁 Requesting access token...');
//     const accessResponse = await axios.get(accessTokenUrl, {
//       headers: { ...accessHeader },
//     });

//     const rawParsed = qs.parse(accessResponse.data);
//     const access_token = decodeURIComponent(rawParsed.oauth_token as string);
//     const access_token_secret = decodeURIComponent(rawParsed.oauth_token_secret as string);

//     console.log('✅ Access token response:', rawParsed);

//     axios.post('https://dashboard-server-prod.vercel.app/api/fetch-sp500-quotes', {
//       access_token,
//       access_token_secret,
//     }).then(() => {
//       console.log('S&P500 Quote fetch complete');
//     }).catch(err => {
//       console.error('⚠️ Failed to trigger background quote fetch:', err.message);
//     });

//     return res.json({
//       access_token,
//       access_token_secret
//     });
//   } catch (err: any) {
//     console.error('❌ Error:', err.response?.data || err.message);
//     return res.status(500).json({ error: 'Failed to get access token or quote' });
//   }
// });

// app.post('/api/fetch-sp500-quotes', async (req: Request, res: Response) => {
//   const { access_token, access_token_secret } = req.body;
//   console.log(`fetch-sp500-quotes api started`);

//   if (!access_token || !access_token_secret) {
//     return res.status(400).json({ error: 'Missing tokens' });
//   }

//   try {
//     const tickersPath = path.join(__dirname, 'sp500_tickers.json');
//     const tickers = JSON.parse(fs.readFileSync(tickersPath, 'utf-8')).sp500_tickers;
//     console.log(`📦 Loaded ${tickers.length} tickers`);

//     const chunkArray = (arr: string[], size: number) =>
//       Array.from({ length: Math.ceil(arr.length / size) }, (_, i) =>
//         arr.slice(i * size, i * size + size)
//       );

//     const chunks = chunkArray(tickers, 50);
//     console.log(`📊 Divided into ${chunks.length} chunks of up to 50`);

//     const results = await Promise.all(
//       chunks.map(async (batch, index) => {
//         const symbols = batch.join(',');
//         const quoteUrl = `https://apisb.etrade.com/v1/market/quote/${symbols}.json?overrideSymbolCount=true`;

//         const quoteRequest = {
//           url: quoteUrl,
//           method: 'GET' as const,
//         };

//         const quoteHeader = oauth.toHeader(
//           oauth.authorize(quoteRequest, {
//             key: access_token,
//             secret: access_token_secret,
//           })
//         );

//         console.log(`📡 Fetching chunk ${index + 1}: ${symbols}`);

//         try {
//           const response = await axios.get(quoteUrl, {
//             headers: { ...quoteHeader },
//           });
//           console.log(`✅ Chunk ${index + 1} success`);
//           // console.log(`response`, response.data.QuoteResponse.QuoteData);

//           const quotes = response.data.QuoteResponse?.QuoteData || [];
//           const withNewHighs = quotes.map((q: any) => {
//             const all = q.All || {};
//             const product = q.Product || {};
//             const symbol = product.symbol || 'N/A';
//             const lastTrade = all.lastTrade;
//             const week52High = all.high52;
//             const isNewHigh = lastTrade !== undefined && week52High !== undefined && lastTrade >= week52High;

//             console.log(`🔍 ${symbol}: lastTrade=${lastTrade}, 52wHigh=${week52High}, newHigh=${isNewHigh}`);

//             return {
//               withNewHighs,
//               symbol,
//               lastTrade: all.lastTrade,
//               week52High,
//               isNewHigh,
//             };
//           });


//         } catch (error) {
//           return null;
//         }
//       })
//     );

//     const combinedQuotes = results.flat().filter(Boolean);

//     console.log(`🎯 Fetched quotes from ${combinedQuotes.length} stocks across ${chunks.length} chunks`);

//     return res.json({ quotes: combinedQuotes });
//   } catch (err: any) {
//     console.error('❌ Error fetching quotes:', err.response?.data || err.message);
//     return res.status(500).json({ error: 'Failed to fetch quotes' });
//   }
// });


// app.post('/api/execute-oauth', async (req: Request, res: Response) => {
//   const { oauth_token, oauth_token_secret, oauth_verifier } = req.body;

//   if (!oauth_token || !oauth_token_secret || !oauth_verifier) {
//     return res.status(400).json({ error: 'Missing required fields' });
//   }

//   const accessTokenUrl = 'https://api.etrade.com/oauth/access_token';
//   const quoteUrl = 'https://apisb.etrade.com/v1/market/lookup/GOOG,IBM,ETFC,GE,XOM,MIGXX,SWOIX.json';
//   try {
//     // Step 1: Exchange verifier for access token
//     const request_data = {
//       url: accessTokenUrl,
//       method: 'GET' as const,
//       data: { oauth_verifier },
//     };

//     const accessHeader = oauth.toHeader(
//       oauth.authorize(request_data, {
//         key: oauth_token,
//         secret: oauth_token_secret,
//       })
//     );

//     const accessResponse = await axios.get(accessTokenUrl, {
//       headers: { ...accessHeader },
//     });

//     const rawParsed = qs.parse(accessResponse.data);
//     const access_token = decodeURIComponent(rawParsed.oauth_token as string);
//     const access_token_secret = decodeURIComponent(rawParsed.oauth_token_secret as string);

//     console.log('✅ Access token response:', rawParsed);

//     // Step 2: Call AAPL quote endpoint
//     const quoteRequest = {
//       url: quoteUrl,
//       method: 'GET' as const,
//     };

//     const quoteHeader = oauth.toHeader(
//       oauth.authorize(quoteRequest, {
//         key: access_token,
//         secret: access_token_secret,
//       })
//     );

//     const quoteResponse = await axios.get(quoteUrl, {
//       headers: { ...quoteHeader },
//     });

//     console.log('📈 AAPL quote response:', quoteResponse.data);

//     return res.json({
//       access_token,
//       access_token_secret,
//       quote: quoteResponse.data,
//     });

//   } catch (err: any) {
//     console.error('❌ Error:', err.response?.data || err.message);
//     return res.status(500).json({ error: 'Failed to get access token or quote' });
//   }
// });

export default app;

app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});
