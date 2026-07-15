// ============================================================
// ===== FIREBASE CDN (No import statements needed) =====
// ============================================================

// ============================================================
// ===== FIREBASE CONFIG =====
// ============================================================
const firebaseConfig = {
  apiKey: "AIzaSyAvcrZt1Z6SGUVcBIhfeGKnLuk-2I_J2Ds",
  authDomain: "the-house-app-23225.firebaseapp.com",
  projectId: "the-house-app-23225",
  storageBucket: "the-house-app-23225.firebasestorage.app",
  messagingSenderId: "85518695125",
  appId: "1:85518695125:android:04f1db11f25f20ee79005c"
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

// ============================================================
// ===== ENVIRONMENT DETECTION =====
// ============================================================

const isProduction = window.location.hostname === 'dhouse.live' ||
  window.location.hostname === 'www.dhouse.live' ||
  window.location.hostname === 'dhouse.pages.dev';

const isDevelopment = window.location.hostname === 'localhost' ||
  window.location.hostname === '127.0.0.1' ||
  window.location.hostname.includes('localhost');

console.log(`🏠 DHouse running in ${isProduction ? 'PRODUCTION' : 'DEVELOPMENT'} mode`);

// ============================================================
// ===== APP VERSION =====
// ============================================================

const APP_VERSION = '2.0.0';
const BUILD_DATE = '2024-07-13';

console.log(`🏠 DHouse v${APP_VERSION} (${BUILD_DATE})`);

// Check if version changed
const savedVersion = localStorage.getItem('dhouse_app_version');
if (savedVersion && savedVersion !== APP_VERSION) {
  console.log('🔄 New version detected, clearing caches...');
  localStorage.setItem('dhouse_app_version', APP_VERSION);
  
  if ('serviceWorker' in navigator) {
    caches.keys().then((cacheNames) => {
      cacheNames.forEach((name) => {
        if (name.startsWith('dhouse-')) {
          caches.delete(name);
          console.log('🗑️ Deleted cache:', name);
        }
      });
    });
  }
  
  showToast('🔄 New version loaded!', true);
} else if (!savedVersion) {
  localStorage.setItem('dhouse_app_version', APP_VERSION);
}

// ============================================================
// ===== FIREBASE PERSISTENCE (OFFLINE SUPPORT) =====
// ============================================================

let persistenceEnabled = false;

async function enableFirestorePersistence() {
  try {
    await db.enablePersistence({
      synchronizeTabs: true
    });
    persistenceEnabled = true;
    console.log('💾 Firestore persistence enabled (offline support)');
  } catch (err) {
    if (err.code === 'failed-precondition') {
      console.warn('⚠️ Persistence failed: Multiple tabs open');
    } else if (err.code === 'unimplemented') {
      console.warn('⚠️ Persistence not supported by browser');
    } else {
      console.error('⚠️ Persistence error:', err);
    }
  }
}

// ============================================================
// ===== DATA MANAGER WITH CACHING =====
// ============================================================

class DataManager {
  constructor() {
    this.cache = {};
    this.cacheTimestamps = {};
    this.pendingRequests = {};
    this.listeners = [];
    
    // Cache TTL in milliseconds
    this.CACHE_TTL = {
      community_posts: 30000,  // 30 seconds
      feed_posts: 30000,       // 30 seconds
      housemates: 60000,       // 60 seconds
      predictions: 30000,      // 30 seconds
      notifications: 10000,    // 10 seconds
      ads: 30000,              // 30 seconds
      user_predictions: 10000, // 10 seconds
      user: 60000,             // 60 seconds
      all_users: 60000,        // 60 seconds
      config: 300000,          // 5 minutes
    };
    
    // Pagination state
    this.pagination = {
      community_posts: {
        lastDoc: null,
        hasMore: true,
        currentPage: 0,
        pageSize: 20,
        allLoaded: false,
      },
      feed_posts: {
        lastDoc: null,
        hasMore: true,
        currentPage: 0,
        pageSize: 20,
        allLoaded: false,
      }
    };
  }

  // ===== CACHE HELPERS =====

  isCacheValid(key) {
    if (!this.cacheTimestamps[key]) return false;
    const ttl = this.CACHE_TTL[key] || 30000;
    return (Date.now() - this.cacheTimestamps[key]) < ttl;
  }

  getCache(key) {
    if (this.isCacheValid(key)) {
      console.log(`📦 Cache hit: ${key}`);
      return this.cache[key];
    }
    console.log(`📦 Cache miss/expired: ${key}`);
    return null;
  }

  setCache(key, data) {
    this.cache[key] = data;
    this.cacheTimestamps[key] = Date.now();
    console.log(`💾 Cached: ${key}`);
  }

  invalidateCache(key) {
    delete this.cache[key];
    delete this.cacheTimestamps[key];
    console.log(`🗑️ Cache invalidated: ${key}`);
  }

  invalidateAllCache() {
    this.cache = {};
    this.cacheTimestamps = {};
    // Reset pagination
    for (const key in this.pagination) {
      this.pagination[key].lastDoc = null;
      this.pagination[key].hasMore = true;
      this.pagination[key].currentPage = 0;
      this.pagination[key].allLoaded = false;
    }
    console.log('🗑️ All cache invalidated');
  }

  // ===== DEDUPE REQUESTS =====

  async dedupeRequest(key, fetchFn) {
    // If there's already a pending request, wait for it
    if (this.pendingRequests[key]) {
      console.log(`⏳ Waiting for pending request: ${key}`);
      return this.pendingRequests[key];
    }

    // Create the request
    const promise = fetchFn();
    this.pendingRequests[key] = promise;

    try {
      const result = await promise;
      return result;
    } finally {
      delete this.pendingRequests[key];
    }
  }

  // ===== DATA FETCHERS =====

  async getCommunityPosts(forceRefresh = false, pageSize = 20) {
    const cacheKey = 'community_posts';
    
    if (!forceRefresh && this.isCacheValid(cacheKey)) {
      const cached = this.cache[cacheKey];
      if (cached && cached.length > 0) {
        return { data: cached, fromCache: true };
      }
    }

    return this.dedupeRequest(cacheKey, async () => {
      try {
        let query = db.collection('community_posts')
          .orderBy('createdAt', 'desc')
          .limit(pageSize);

        const paginationState = this.pagination.community_posts;
        
        if (paginationState.lastDoc) {
          query = query.startAfter(paginationState.lastDoc);
        }

        const snapshot = await query.get();
        const posts = [];
        
        snapshot.forEach((doc) => {
          const data = doc.data();
          posts.push({
            id: doc.id,
            user: data.username || data.user || 'Anonymous',
            username: data.username || '@user',
            userId: data.userId || '',
            time: data.createdAt?.toDate?.()?.toLocaleString() || 'Just now',
            content: data.content || '',
            likes: data.likes || 0,
            comments: data.commentCount || data.comments || 0,
            commentCount: data.commentCount || data.comments || 0,
            shares: data.shares || 0,
            liked: data.liked || false,
            tags: data.tags || [],
            images: data.imageUrls || data.images || [],
            emojiReactions: data.emojiReactions || {},
            timestamp: data.createdAt || data.timestamp,
            createdAt: data.createdAt
          });
        });

        // Update pagination state
        if (snapshot.docs.length > 0) {
          paginationState.lastDoc = snapshot.docs[snapshot.docs.length - 1];
        }
        paginationState.hasMore = snapshot.docs.length === pageSize;
        paginationState.currentPage++;

        // Cache the data
        this.setCache(cacheKey, posts);
        
        return { data: posts, fromCache: false, hasMore: paginationState.hasMore };
      } catch (error) {
        console.error('Error fetching community posts:', error);
        // Try to return cached data even if expired
        if (this.cache[cacheKey]) {
          console.log('📦 Using stale cache for community posts');
          return { data: this.cache[cacheKey], fromCache: true, stale: true };
        }
        return { data: [], fromCache: false, hasMore: false, error: error.message };
      }
    });
  }

  async getFeedPosts(forceRefresh = false, pageSize = 20) {
    const cacheKey = 'feed_posts';
    
    if (!forceRefresh && this.isCacheValid(cacheKey)) {
      const cached = this.cache[cacheKey];
      if (cached && cached.length > 0) {
        return { data: cached, fromCache: true };
      }
    }

    return this.dedupeRequest(cacheKey, async () => {
      try {
        let query = db.collection('feed_posts')
          .orderBy('createdAt', 'desc')
          .limit(pageSize);

        const paginationState = this.pagination.feed_posts;
        
        if (paginationState.lastDoc) {
          query = query.startAfter(paginationState.lastDoc);
        }

        const snapshot = await query.get();
        const posts = [];
        
        snapshot.forEach((doc) => {
          const data = doc.data();
          posts.push({
            id: doc.id,
            type: data.type || 'text',
            content: data.message || data.content || '',
            message: data.message || '',
            imageUrls: data.imageUrls || [],
            pollOptions: data.pollOptions || [],
            pollVotes: data.pollVotes || {},
            likes: data.likes || 0,
            comments: data.commentCount || data.comments || 0,
            commentCount: data.commentCount || data.comments || 0,
            reactions: data.reactions || {},
            liked: data.liked || false,
            timestamp: data.createdAt || data.timestamp,
            time: data.createdAt?.toDate?.()?.toLocaleString() || 'Just now',
            user: data.user || 'DHouse Admin',
            displayIcons: data.displayIcons || [],
            reactionIcons: data.reactionIcons || [],
            votes: data.votes || [],
            createdAt: data.createdAt,
            emojiReactions: data.emojiReactions || {}
          });
        });

        if (snapshot.docs.length > 0) {
          paginationState.lastDoc = snapshot.docs[snapshot.docs.length - 1];
        }
        paginationState.hasMore = snapshot.docs.length === pageSize;
        paginationState.currentPage++;

        this.setCache(cacheKey, posts);
        return { data: posts, fromCache: false, hasMore: paginationState.hasMore };
      } catch (error) {
        console.error('Error fetching feed posts:', error);
        if (this.cache[cacheKey]) {
          return { data: this.cache[cacheKey], fromCache: true, stale: true };
        }
        return { data: [], fromCache: false, hasMore: false, error: error.message };
      }
    });
  }

  async getHousemates(forceRefresh = false) {
    const cacheKey = 'housemates';
    
    if (!forceRefresh && this.isCacheValid(cacheKey)) {
      const cached = this.cache[cacheKey];
      if (cached) return { data: cached, fromCache: true };
    }

    return this.dedupeRequest(cacheKey, async () => {
      try {
        const snapshot = await db.collection('housemates')
          .orderBy('name', 'asc')
          .get();
        
        const housemates = [];
        snapshot.forEach((doc) => {
          housemates.push({ id: doc.id, ...doc.data() });
        });

        this.setCache(cacheKey, housemates);
        return { data: housemates, fromCache: false };
      } catch (error) {
        console.error('Error fetching housemates:', error);
        if (this.cache[cacheKey]) {
          return { data: this.cache[cacheKey], fromCache: true, stale: true };
        }
        return { data: [], fromCache: false, error: error.message };
      }
    });
  }

  async getPredictions(forceRefresh = false) {
    const cacheKey = 'predictions';
    
    if (!forceRefresh && this.isCacheValid(cacheKey)) {
      const cached = this.cache[cacheKey];
      if (cached) return { data: cached, fromCache: true };
    }

    return this.dedupeRequest(cacheKey, async () => {
      try {
        const snapshot = await db.collection('predictions')
          .orderBy('createdAt', 'desc')
          .get();
        
        const predictions = [];
        snapshot.forEach((doc) => {
          predictions.push({ id: doc.id, ...doc.data() });
        });

        this.setCache(cacheKey, predictions);
        return { data: predictions, fromCache: false };
      } catch (error) {
        console.error('Error fetching predictions:', error);
        if (this.cache[cacheKey]) {
          return { data: this.cache[cacheKey], fromCache: true, stale: true };
        }
        return { data: [], fromCache: false, error: error.message };
      }
    });
  }

  async getNotifications(userId, forceRefresh = false) {
    if (!userId) return { data: [], fromCache: false };
    
    const cacheKey = `notifications_${userId}`;
    
    if (!forceRefresh && this.isCacheValid(cacheKey)) {
      const cached = this.cache[cacheKey];
      if (cached) return { data: cached, fromCache: true };
    }

    return this.dedupeRequest(cacheKey, async () => {
      try {
        const snapshot = await db.collection('notifications')
          .where('to', '==', userId)
          .orderBy('timestamp', 'desc')
          .limit(50)
          .get();
        
        const notifications = [];
        snapshot.forEach((doc) => {
          const data = doc.data();
          notifications.push({
            id: doc.id,
            type: data.type || 'tag',
            from: data.from || '',
            to: data.to || '',
            message: data.message || '',
            read: data.read || false,
            time: data.time || 'Just now',
            timestamp: data.timestamp,
            fromName: data.fromName || 'Someone',
            postId: data.postId || '',
            commentId: data.commentId || '',
            parentCommentId: data.parentCommentId || '',
            replyText: data.replyText || ''
          });
        });

        this.setCache(cacheKey, notifications);
        return { data: notifications, fromCache: false };
      } catch (error) {
        console.error('Error fetching notifications:', error);
        if (this.cache[cacheKey]) {
          return { data: this.cache[cacheKey], fromCache: true, stale: true };
        }
        return { data: [], fromCache: false, error: error.message };
      }
    });
  }

  async getAds(forceRefresh = false) {
    const cacheKey = 'ads';
    
    if (!forceRefresh && this.isCacheValid(cacheKey)) {
      const cached = this.cache[cacheKey];
      if (cached) return { data: cached, fromCache: true };
    }

    return this.dedupeRequest(cacheKey, async () => {
      try {
        const snapshot = await db.collection('ads')
          .where('status', '==', 'approved')
          .get();
        
        const ads = [];
        snapshot.forEach((doc) => {
          const data = doc.data();
          if ((data.budgetLeft || 0) <= 0) return;
          ads.push({ id: doc.id, ...data });
        });

        this.setCache(cacheKey, ads);
        return { data: ads, fromCache: false };
      } catch (error) {
        console.error('Error fetching ads:', error);
        if (this.cache[cacheKey]) {
          return { data: this.cache[cacheKey], fromCache: true, stale: true };
        }
        return { data: [], fromCache: false, error: error.message };
      }
    });
  }

  async getUserPredictions(userId, forceRefresh = false) {
    if (!userId) return { data: {}, fromCache: false };
    
    const cacheKey = `user_predictions_${userId}`;
    
    if (!forceRefresh && this.isCacheValid(cacheKey)) {
      const cached = this.cache[cacheKey];
      if (cached) return { data: cached, fromCache: true };
    }

    return this.dedupeRequest(cacheKey, async () => {
      try {
        const snapshot = await db.collection('user_predictions')
          .where('userId', '==', userId)
          .get();
        
        const userPredictions = {};
        snapshot.forEach((doc) => {
          const data = doc.data();
          userPredictions[data.predictionId] = {
            id: doc.id,
            ...data
          };
        });

        this.setCache(cacheKey, userPredictions);
        return { data: userPredictions, fromCache: false };
      } catch (error) {
        console.error('Error fetching user predictions:', error);
        if (this.cache[cacheKey]) {
          return { data: this.cache[cacheKey], fromCache: true, stale: true };
        }
        return { data: {}, fromCache: false, error: error.message };
      }
    });
  }

  async getAllUsers(forceRefresh = false) {
    const cacheKey = 'all_users';
    
    if (!forceRefresh && this.isCacheValid(cacheKey)) {
      const cached = this.cache[cacheKey];
      if (cached) return { data: cached, fromCache: true };
    }

    return this.dedupeRequest(cacheKey, async () => {
      try {
        const snapshot = await db.collection('users').get();
        const users = [];
        snapshot.forEach((doc) => {
          users.push({ id: doc.id, ...doc.data() });
        });

        this.setCache(cacheKey, users);
        return { data: users, fromCache: false };
      } catch (error) {
        console.error('Error fetching users:', error);
        if (this.cache[cacheKey]) {
          return { data: this.cache[cacheKey], fromCache: true, stale: true };
        }
        return { data: [], fromCache: false, error: error.message };
      }
    });
  }

  // ===== LOAD MORE FUNCTIONS =====

  async loadMoreCommunityPosts(pageSize = 20) {
    const paginationState = this.pagination.community_posts;
    
    if (!paginationState.hasMore || paginationState.allLoaded) {
      return { data: [], hasMore: false, allLoaded: true };
    }

    return this.dedupeRequest('community_posts_more', async () => {
      try {
        let query = db.collection('community_posts')
          .orderBy('createdAt', 'desc')
          .limit(pageSize);

        if (paginationState.lastDoc) {
          query = query.startAfter(paginationState.lastDoc);
        }

        const snapshot = await query.get();
        const posts = [];
        
        snapshot.forEach((doc) => {
          const data = doc.data();
          posts.push({
            id: doc.id,
            user: data.username || data.user || 'Anonymous',
            username: data.username || '@user',
            userId: data.userId || '',
            time: data.createdAt?.toDate?.()?.toLocaleString() || 'Just now',
            content: data.content || '',
            likes: data.likes || 0,
            comments: data.commentCount || data.comments || 0,
            commentCount: data.commentCount || data.comments || 0,
            shares: data.shares || 0,
            liked: data.liked || false,
            tags: data.tags || [],
            images: data.imageUrls || data.images || [],
            emojiReactions: data.emojiReactions || {},
            timestamp: data.createdAt || data.timestamp,
            createdAt: data.createdAt
          });
        });

        if (snapshot.docs.length > 0) {
          paginationState.lastDoc = snapshot.docs[snapshot.docs.length - 1];
        }
        paginationState.hasMore = snapshot.docs.length === pageSize;
        paginationState.currentPage++;

        if (!paginationState.hasMore) {
          paginationState.allLoaded = true;
        }

        // Update cache with new data
        const existingCache = this.cache['community_posts'] || [];
        const mergedData = [...existingCache, ...posts];
        this.setCache('community_posts', mergedData);

        return { 
          data: posts, 
          hasMore: paginationState.hasMore,
          allLoaded: paginationState.allLoaded,
          fromCache: false 
        };
      } catch (error) {
        console.error('Error loading more community posts:', error);
        return { data: [], hasMore: false, allLoaded: true, error: error.message };
      }
    });
  }

  async loadMoreFeedPosts(pageSize = 20) {
    const paginationState = this.pagination.feed_posts;
    
    if (!paginationState.hasMore || paginationState.allLoaded) {
      return { data: [], hasMore: false, allLoaded: true };
    }

    return this.dedupeRequest('feed_posts_more', async () => {
      try {
        let query = db.collection('feed_posts')
          .orderBy('createdAt', 'desc')
          .limit(pageSize);

        if (paginationState.lastDoc) {
          query = query.startAfter(paginationState.lastDoc);
        }

        const snapshot = await query.get();
        const posts = [];
        
        snapshot.forEach((doc) => {
          const data = doc.data();
          posts.push({
            id: doc.id,
            type: data.type || 'text',
            content: data.message || data.content || '',
            message: data.message || '',
            imageUrls: data.imageUrls || [],
            pollOptions: data.pollOptions || [],
            pollVotes: data.pollVotes || {},
            likes: data.likes || 0,
            comments: data.commentCount || data.comments || 0,
            commentCount: data.commentCount || data.comments || 0,
            reactions: data.reactions || {},
            liked: data.liked || false,
            timestamp: data.createdAt || data.timestamp,
            time: data.createdAt?.toDate?.()?.toLocaleString() || 'Just now',
            user: data.user || 'DHouse Admin',
            displayIcons: data.displayIcons || [],
            reactionIcons: data.reactionIcons || [],
            votes: data.votes || [],
            createdAt: data.createdAt,
            emojiReactions: data.emojiReactions || {}
          });
        });

        if (snapshot.docs.length > 0) {
          paginationState.lastDoc = snapshot.docs[snapshot.docs.length - 1];
        }
        paginationState.hasMore = snapshot.docs.length === pageSize;
        paginationState.currentPage++;

        if (!paginationState.hasMore) {
          paginationState.allLoaded = true;
        }

        const existingCache = this.cache['feed_posts'] || [];
        const mergedData = [...existingCache, ...posts];
        this.setCache('feed_posts', mergedData);

        return { 
          data: posts, 
          hasMore: paginationState.hasMore,
          allLoaded: paginationState.allLoaded,
          fromCache: false 
        };
      } catch (error) {
        console.error('Error loading more feed posts:', error);
        return { data: [], hasMore: false, allLoaded: true, error: error.message };
      }
    });
  }

  // ===== RESET PAGINATION =====

  resetPagination(key) {
    if (this.pagination[key]) {
      this.pagination[key].lastDoc = null;
      this.pagination[key].hasMore = true;
      this.pagination[key].currentPage = 0;
      this.pagination[key].allLoaded = false;
    }
    this.invalidateCache(key);
  }

  // ===== REAL-TIME LISTENERS =====

  setupRealTimeListeners(userId) {
    // Clean up old listeners
    this.cleanupListeners();

    // Only set up listeners for notifications and user predictions
    if (userId) {
      // Notifications listener
      const notifUnsubscribe = db.collection('notifications')
        .where('to', '==', userId)
        .onSnapshot((snapshot) => {
          const notifications = [];
          snapshot.forEach((doc) => {
            const data = doc.data();
            notifications.push({
              id: doc.id,
              type: data.type || 'tag',
              from: data.from || '',
              to: data.to || '',
              message: data.message || '',
              read: data.read || false,
              time: data.time || 'Just now',
              timestamp: data.timestamp,
              fromName: data.fromName || 'Someone',
              postId: data.postId || '',
              commentId: data.commentId || '',
              parentCommentId: data.parentCommentId || '',
              replyText: data.replyText || ''
            });
          });
          
          // Update cache
          this.setCache(`notifications_${userId}`, notifications);
          
          // Update global state
          window.notifications = notifications;
          window.notificationCount = notifications.filter(n => !n.read).length;
          
          // Re-render if on notifications tab
          if (window.activeTab === 'notifications' && !window.isAdmin) {
            window.renderMainApp();
          }
          if (window.isAdmin) {
            window.renderAdminApp();
          }
        }, (error) => {
          console.error('Notifications listener error:', error);
        });
      
      this.listeners.push(notifUnsubscribe);

      // User predictions listener
      const predUnsubscribe = db.collection('user_predictions')
        .where('userId', '==', userId)
        .onSnapshot((snapshot) => {
          const userPredictions = {};
          snapshot.forEach((doc) => {
            const data = doc.data();
            userPredictions[data.predictionId] = {
              id: doc.id,
              ...data
            };
          });
          
          this.setCache(`user_predictions_${userId}`, userPredictions);
          window.userPredictions = userPredictions;
          
          if (window.activeTab === 'predictions' && !window.isAdmin) {
            window.renderMainApp();
          }
        }, (error) => {
          console.error('User predictions listener error:', error);
        });
      
      this.listeners.push(predUnsubscribe);
    }

    console.log(`📡 Real-time listeners set up (${this.listeners.length} active)`);
  }

  cleanupListeners() {
    this.listeners.forEach(unsubscribe => {
      try { unsubscribe(); } catch (e) {}
    });
    this.listeners = [];
    console.log('📡 Cleaned up real-time listeners');
  }
}

// ============================================================
// ===== INITIALIZE DATA MANAGER =====
// ============================================================

const dataManager = new DataManager();

// ============================================================
// ===== ANALYTICS INITIALIZATION =====
// ============================================================

let analytics = null;

try {
  analytics = firebase.analytics();
  if (analytics && isDevelopment) {
    // analytics.setAnalyticsCollectionEnabled(false);
    console.log('📊 Analytics running in development mode');
  } else if (analytics) {
    console.log('📊 Analytics enabled for production');
  }
} catch (error) {
  console.warn('⚠️ Analytics initialization failed:', error);
}

// ============================================================
// ===== SENTRY INITIALIZATION =====
// ============================================================

const SENTRY_DSN = 'https://caffaaa8422dcf12bcde271a9153ea2e@o4511719229292544.ingest.de.sentry.io/4511722814701648';

if (typeof Sentry !== 'undefined') {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: isProduction ? 'production' : 'development',
    release: '2.0.0',
    tracesSampleRate: 0.1,
    // Remove BrowserTracing and Replay if they're not in your bundle
    // Or use a different CDN URL that includes them
  });
  
  console.log('📊 Sentry initialized for error tracking');
} else {
  console.warn('⚠️ Sentry SDK not loaded');
}
// ============================================================
// ===== GLOBAL ERROR HANDLING =====
// ============================================================

window.addEventListener('unhandledrejection', function(event) {
  if (typeof Sentry !== 'undefined') {
    Sentry.captureException(event.reason, {
      tags: {
        type: 'unhandledRejection',
      },
      extra: {
        promise: event.promise,
        reason: event.reason,
      },
    });
  }
  console.error('🔴 Unhandled Rejection:', event.reason);
});

window.addEventListener('error', function(event) {
  if (typeof Sentry !== 'undefined') {
    Sentry.captureException(event.error || event.message, {
      tags: {
        type: 'uncaughtError',
      },
      extra: {
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
      },
    });
  }
  console.error('🔴 Uncaught Error:', event.message);
});

// ============================================================
// ===== ANALYTICS HELPER FUNCTIONS =====
// ============================================================

function logEvent(eventName, eventParams = {}) {
  try {
    if (analytics) {
      if (currentUser) {
        analytics.setUserId(currentUser.uid);
      }
      analytics.logEvent(eventName, eventParams);
      console.log(`📊 Event logged: ${eventName}`, eventParams);
    }
  } catch (error) {
    console.warn('Analytics error:', error);
  }
}

function setUserProperties(properties) {
  try {
    if (analytics) {
      analytics.setUserProperties(properties);
      console.log('📊 User properties set:', properties);
    }
  } catch (error) {
    console.warn('Analytics error:', error);
  }
}

function logScreenView(screenName, screenClass = '') {
  logEvent('screen_view', {
    screen_name: screenName,
    screen_class: screenClass || screenName
  });
}

// ============================================================
// ===== R2 CONFIGURATION =====
// ============================================================

const R2_API_URL = 'https://dhouse-api.aplusbuddyhelp.workers.dev';
const R2_IMAGE_BASE = 'https://dhouse-api.aplusbuddyhelp.workers.dev';
const MAX_IMAGES = 7;
const POINTS_PER_INTERACTION = 10;
const COST_PER_IMPRESSION = 0.50;
const OPAY_ACCOUNT = '1234567890';
const OPAY_ACCOUNT_NAME = 'DHouse Admin';
const OPAY_BANK = 'Opay';

// ============================================================
// ===== CONSTANTS =====
// ============================================================

const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/bmp',
];

const MIME_TO_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
};

const MAX_UPLOAD_SIZE = 3 * 1024 * 1024;
const DEBUG_UPLOAD = false;

// ============================================================
// ===== ADMIN CONFIGURATION (from Firestore) =====
// ============================================================

let cachedAdminConfig = null;
let adminConfigCacheTime = 0;
const ADMIN_CONFIG_CACHE_TTL = 300000; // 5 minutes

// ============================================================
// ===== ADMIN FUNCTIONS =====
// ============================================================

async function getAdminConfig() {
  const now = Date.now();
  if (cachedAdminConfig && (now - adminConfigCacheTime) < ADMIN_CONFIG_CACHE_TTL) {
    return cachedAdminConfig;
  }
  
  try {
    const doc = await db.collection('admin_settings').doc('config').get();
    if (doc.exists) {
      cachedAdminConfig = doc.data();
      adminConfigCacheTime = now;
      return cachedAdminConfig;
    }
    // Create default config if it doesn't exist
    const defaultConfig = {
      adminEmail: "cashplug318@gmail.com",
      appVersion: "2.0.0",
      adStatus: "available",
      maintenanceMode: false,
      lastUpdated: new Date().toISOString()
    };
    await db.collection('admin_settings').doc('config').set(defaultConfig);
    cachedAdminConfig = defaultConfig;
    adminConfigCacheTime = now;
    return defaultConfig;
  } catch (error) {
    console.error('Error fetching admin config:', error);
    return null;
  }
}

async function isUserAdmin(user) {
  if (!user) return false;
  
  const config = await getAdminConfig();
  if (!config) return false;
  
  if (config.adminEmail && config.adminEmail === user.email) {
    return true;
  }
  
  return false;
}

async function isMaintenanceMode() {
  const config = await getAdminConfig();
  return config?.maintenanceMode || false;
}

async function getAppVersion() {
  const config = await getAdminConfig();
  return config?.appVersion || '2.0.0';
}

async function getAdStatus() {
  const config = await getAdminConfig();
  return config?.adStatus || 'available';
}

async function updateAdminSettings(newConfig) {
  if (!await isUserAdmin(currentUser)) {
    showToast('❌ Admin access required', false);
    return false;
  }
  
  try {
    await db.collection('admin_settings').doc('config').update({
      ...newConfig,
      lastUpdated: new Date().toISOString()
    });
    cachedAdminConfig = null;
    showToast('✅ Admin settings updated!', true);
    return true;
  } catch (error) {
    console.error('Error updating admin settings:', error);
    showToast('❌ Failed to update settings.', false);
    return false;
  }
}

async function toggleMaintenanceMode() {
  const config = await getAdminConfig();
  return await updateAdminSettings({
    maintenanceMode: !config?.maintenanceMode
  });
}

async function updateAppVersion(version) {
  return await updateAdminSettings({
    appVersion: version
  });
}

async function updateAdStatus(status) {
  return await updateAdminSettings({
    adStatus: status
  });
}

// ============================================================
// ===== NETWORK STATUS INDICATOR =====
// ============================================================

function showNetworkStatus(online) {
  const statusEl = document.getElementById('networkStatus');
  if (!statusEl) return;
  
  if (online) {
    statusEl.textContent = '🌐 Back online';
    statusEl.style.background = 'rgba(76, 175, 80, 0.95)';
    statusEl.style.color = 'white';
    statusEl.style.display = 'block';
    
    clearTimeout(statusEl._hideTimeout);
    statusEl._hideTimeout = setTimeout(() => {
      statusEl.style.display = 'none';
    }, 3000);
  } else {
    statusEl.textContent = '📡 No internet connection. Please check your network.';
    statusEl.style.background = 'rgba(229, 57, 53, 0.95)';
    statusEl.style.color = 'white';
    statusEl.style.display = 'block';
  }
}

window.addEventListener('online', () => {
  console.log('🌐 Network reconnected');
  showNetworkStatus(true);
  showToast('🌐 Network reconnected!', true);
});

window.addEventListener('offline', () => {
  console.log('📡 Network disconnected');
  showNetworkStatus(false);
  showToast('📡 No internet connection. Please check your network.', false);
});

if (!navigator.onLine) {
  showNetworkStatus(false);
}

// ============================================================
// ===== UPLOAD HELPERS =====
// ============================================================

function generateUploadFilename(file) {
  const id = crypto.randomUUID ? crypto.randomUUID() : 
             Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 8);
  
  let ext = 'jpg';
  if (file instanceof File && file.name) {
    const parts = file.name.split('.');
    if (parts.length > 1) {
      ext = parts[parts.length - 1].toLowerCase();
    }
  } else if (file.type && MIME_TO_EXT[file.type]) {
    ext = MIME_TO_EXT[file.type];
  }
  
  return `${id}.${ext}`;
}

function getAdaptiveTimeout(fileSize) {
  const sizeInMB = fileSize / (1024 * 1024);
  return Math.min(30000 + sizeInMB * 10000, 60000);
}

function isNetworkError(error) {
  if (error instanceof TypeError) return true;
  if (error.name === 'AbortError') return true;
  if (error.statusCode && [502, 503, 504].includes(error.statusCode)) return true;
  
  const patterns = /fetch|network|timeout|abort|failed|connection|disconnect|offline|dns|unreachable|gateway|service unavailable/i;
  return patterns.test(error.message || '');
}

function isAuthError(error) {
  return error.statusCode === 401 || 
         (error.message && (error.message.includes('401') || error.message.includes('unauthorized')));
}

function isValidationError(error) {
  return error.statusCode && [400, 413, 415].includes(error.statusCode);
}

function safeCallback(fn, ...args) {
  if (typeof fn === 'function') {
    try { fn(...args); } catch (err) { console.error('Callback error:', err); }
  }
}

// ============================================================
// ===== R2 UPLOAD FUNCTIONS =====
// ============================================================

function createControlledFetchSignal(timeout, callerSignal) {
  const controller = new AbortController();
  let onAbort = null;
  
  const timeoutId = setTimeout(() => {
    controller.abort(new DOMException('Upload timeout', 'TimeoutError'));
  }, timeout);
  
  if (callerSignal) {
    if (callerSignal.aborted) {
      clearTimeout(timeoutId);
      controller.abort(callerSignal.reason || new DOMException('Upload cancelled', 'AbortError'));
    } else {
      onAbort = () => {
        clearTimeout(timeoutId);
        controller.abort(callerSignal.reason || new DOMException('Upload cancelled', 'AbortError'));
      };
      callerSignal.addEventListener('abort', onAbort, { once: true });
    }
  }
  
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeoutId);
      if (callerSignal && onAbort) {
        callerSignal.removeEventListener('abort', onAbort);
      }
    }
  };
}

async function uploadToR2(file, folder = 'uploads', options = {}) {
  const {
    maxRetries = 3,
      timeoutMs = null,
      onRetry = null,
      signal = null,
  } = options;
  
  if (!file) throw new Error('No file provided');
  if (signal?.aborted) throw new DOMException('Upload cancelled', 'AbortError');
  
  const filename = generateUploadFilename(file);
  
  if (!(file instanceof Blob) && !(file instanceof File)) {
    throw new Error('Invalid file - not a Blob or File');
  }
  if (file.size === 0) throw new Error('File is empty');
  if (file.size > MAX_UPLOAD_SIZE) {
    throw new Error(`File too large: ${(file.size / 1024 / 1024).toFixed(2)}MB. Max 3MB`);
  }
  if (!ALLOWED_MIME_TYPES.includes(file.type)) {
    throw new Error(`Invalid file type: ${file.type}`);
  }
  
  const timeout = timeoutMs || getAdaptiveTimeout(file.size);
  let lastError = null;
  let authRefreshAttempted = false;
  let forceRefreshToken = false;
  
  async function doUpload(attempt) {
    if (signal?.aborted) {
      throw new DOMException('Upload cancelled', 'AbortError');
    }
    
    const isRetry = attempt > 0;
    if (DEBUG_UPLOAD) {
      console.log(`📤 ${isRetry ? `[Retry ${attempt}/${maxRetries}] ` : ''}${filename} (${(file.size / 1024).toFixed(1)}KB)`);
    }
    
    const formData = new FormData();
    formData.append('image', file, filename);
    formData.append('folder', folder);
    
    let token = null;
    try {
      const user = firebase.auth().currentUser;
      if (user) {
        token = await user.getIdToken(forceRefreshToken);
      }
    } catch (e) {
      if (DEBUG_UPLOAD) console.log('Could not get auth token:', e);
    }
    
    const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
    
    const { signal: fetchSignal, cleanup } = createControlledFetchSignal(timeout, signal);
    
    let response;
    try {
      response = await fetch(`${R2_API_URL}/upload`, {
        method: 'POST',
        body: formData,
        headers,
        signal: fetchSignal,
      });
    } finally {
      cleanup();
    }
    
    if (response.status === 401) {
      if (authRefreshAttempted) {
        const error = new Error('Authentication failed after token refresh');
        error.statusCode = 401;
        throw error;
      }
      
      if (DEBUG_UPLOAD) console.log('🔑 Token expired, refreshing...');
      authRefreshAttempted = true;
      forceRefreshToken = true;
      
      const error = new Error('Token expired');
      error.statusCode = 401;
      throw error;
    }
    
    if (response.status === 429) {
      let retryAfter = 60;
      try {
        const header = response.headers.get('Retry-After');
        if (header) {
          const parsed = parseInt(header);
          if (!isNaN(parsed)) {
            retryAfter = parsed;
          } else {
            const date = new Date(header);
            if (!isNaN(date.getTime())) {
              const diff = Math.ceil((date.getTime() - Date.now()) / 1000);
              retryAfter = Math.max(diff, 1);
            }
          }
        }
      } catch {}
      
      const error = new Error(`Rate limited. Retry after ${retryAfter}s`);
      error.statusCode = 429;
      error.retryAfter = retryAfter;
      throw error;
    }
    
    if ([502, 503, 504].includes(response.status)) {
      const error = new TypeError(`Temporary server error (${response.status})`);
      error.statusCode = response.status;
      throw error;
    }
    
    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try {
        const data = await response.json();
        message = data.error || data.message || message;
      } catch {}
      
      const error = new Error(message);
      error.statusCode = response.status;
      throw error;
    }
    
    const data = await response.json();
    if (data.success && data.url) return data.url;
    throw new Error(data.error || 'Upload failed');
  }
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (signal?.aborted) {
        throw new DOMException('Upload cancelled', 'AbortError');
      }
      return await doUpload(attempt);
    } catch (error) {
      lastError = error;
      
      const isNetError = isNetworkError(error);
      const isAuthErr = isAuthError(error);
      const isValidationErr = isValidationError(error);
      const isRateLimit = error.statusCode === 429;
      
      if (attempt === maxRetries || (isValidationErr && !isAuthErr)) {
        const msg = isAuthErr ? 'Authentication error. Please sign in again.' :
          isNetError ? 'Network error. Please check your connection.' :
          isRateLimit ? 'Too many uploads. Please wait.' :
          error.message || 'Upload failed';
        
        if (typeof Sentry !== 'undefined') {
          Sentry.captureException(error, {
            tags: {
              folder: folder,
              fileSize: file?.size,
              fileType: file?.type,
              isRetry: attempt > 0,
              maxRetries: maxRetries,
              errorType: isNetError ? 'network' : isAuthErr ? 'auth' : isRateLimit ? 'rate_limit' : 'unknown',
            },
            extra: {
              filename: file?.name,
              attempt: attempt,
              maxRetries: maxRetries,
              errorMessage: error.message,
            },
          });
        }
        
        throw new Error(msg);
      }
      
      if (isAuthErr && authRefreshAttempted) {
        throw new Error('Authentication failed after token refresh. Please sign in again.');
      }
      
      let delay;
      if (isRateLimit && error.retryAfter) {
        delay = error.retryAfter * 1000;
      } else if (isAuthErr) {
        delay = 1000;
      } else {
        const baseDelay = Math.min(Math.pow(2, attempt) * 1000, 8000);
        const jitter = Math.random() * 500;
        delay = baseDelay + jitter;
      }
      
      if (DEBUG_UPLOAD) {
        console.log(`🔄 Retry ${attempt + 1}/${maxRetries} in ${(delay / 1000).toFixed(1)}s`);
      }
      safeCallback(onRetry, attempt + 1, delay, error);
      
      await new Promise((resolve, reject) => {
        let abortHandler = null;
        const timer = setTimeout(() => {
          if (abortHandler && signal) signal.removeEventListener('abort', abortHandler);
          resolve();
        }, delay);
        if (signal) {
          abortHandler = () => {
            clearTimeout(timer);
            if (abortHandler && signal) signal.removeEventListener('abort', abortHandler);
            reject(new DOMException('Upload cancelled', 'AbortError'));
          };
          signal.addEventListener('abort', abortHandler);
        }
      });
    }
  }
  
  throw lastError || new Error('Upload failed');
}

async function uploadMultipleToR2(files, folder = 'uploads', options = {}) {
  const { onRetry = null, onProgress = null, signal = null } = options;
  
  if (!Array.isArray(files)) files = [files];
  
  const validFiles = files.filter(f => {
    if (!f) return false;
    if (typeof f === 'string' && f.startsWith('http')) return false;
    return (f instanceof Blob || f instanceof File) && f.size > 0;
  });
  
  if (validFiles.length === 0) return [];
  
  if (DEBUG_UPLOAD) {
    console.log(`📤 Uploading ${validFiles.length} files to ${folder}`);
  }
  
  const results = [];
  const errors = [];
  
  for (let i = 0; i < validFiles.length; i++) {
    if (signal?.aborted) {
      throw new DOMException('Upload cancelled', 'AbortError');
    }
    
    const file = validFiles[i];
    let uploadFile = file?.file || file;
    
    try {
      if (typeof uploadFile === 'string' && uploadFile.startsWith('http')) {
        results.push(uploadFile);
        continue;
      }
      
      const url = await uploadToR2(uploadFile, folder, {
        onRetry: (attempt, delay, error) => {
          safeCallback(onRetry, i + 1, attempt, delay, error);
        },
        signal,
      });
      
      results.push(url);
      if (DEBUG_UPLOAD) {
        console.log(`✅ File ${i + 1}/${validFiles.length} uploaded`);
      }
      safeCallback(onProgress, i + 1, validFiles.length);
    } catch (error) {
      const msg = error.message || 'Unknown error';
      console.error(`❌ File ${i + 1} failed:`, msg);
      errors.push(`File ${i + 1}: ${msg}`);
    }
  }
  
  if (errors.length > 0) {
    console.warn(`⚠️ ${errors.length}/${validFiles.length} files failed`);
  }
  
  if (results.length === 0 && validFiles.length > 0) {
    throw new Error('All uploads failed');
  }
  
  return results;
}

// Folder-specific helpers
async function uploadPostImages(files, options = {}) {
  return await uploadMultipleToR2(files, 'posts', options);
}

async function uploadProfileImage(file, options = {}) {
  return await uploadToR2(file, 'avatars', options);
}

// ============================================================
// ===== FIRESTORE ERROR HELPER =====
// ============================================================

function captureFirestoreError(error, operation, data = {}) {
  console.error(`❌ Firestore ${operation} error:`, error);
  
  if (typeof Sentry !== 'undefined') {
    Sentry.captureException(error, {
      tags: {
        operation: operation,
        errorCode: error.code || 'unknown',
      },
      extra: {
        ...data,
        errorMessage: error.message,
        errorDetails: error.customData || {},
      },
    });
  }
}

async function uploadAdImage(file, options = {}) {
  return await uploadToR2(file, 'ads', options);
}

async function uploadSponsorImage(file, options = {}) {
  return await uploadToR2(file, 'sponsors', options);
}

async function uploadHousemateImage(file, options = {}) {
  return await uploadToR2(file, 'housemates', options);
}

function getOptimizedImageUrl(url, width = 800) {
  if (!url) return '';
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return url;
  }
  if (url.startsWith('/')) {
    return `${R2_IMAGE_BASE}${url}`;
  }
  return url;
}

// ============================================================
// ===== DELETE IMAGES FROM R2 =====
// ============================================================

async function deleteR2Images(imageUrls) {
  if (!imageUrls || imageUrls.length === 0) return;
  
  console.log(`🗑️ Cleaning up ${imageUrls.length} orphaned images...`);
  
  const deletePromises = imageUrls.map(async (url) => {
    try {
      const match = url.match(/\/images\/(.+)$/);
      if (!match) {
        console.warn('Could not extract filename from URL:', url);
        return;
      }
      
      const filename = match[1];
      
      let token = null;
      try {
        const user = firebase.auth().currentUser;
        if (user) {
          token = await user.getIdToken();
        }
      } catch (e) {
        console.log('Could not get auth token for delete:', e);
      }
      
      const headers = {};
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
      
      const response = await fetch(`${R2_API_URL}/images/${filename}`, {
        method: 'DELETE',
        headers: headers,
      });
      
      if (response.ok) {
        console.log(`✅ Deleted: ${filename}`);
      } else {
        console.warn(`⚠️ Failed to delete: ${filename} (${response.status})`);
      }
    } catch (error) {
      console.error('Error deleting image:', error);
    }
  });
  
  await Promise.allSettled(deletePromises);
  console.log('🗑️ Cleanup complete');
}

// ============================================================
// ===== COMPRESS IMAGE =====
// ============================================================

async function compressImage(file, maxWidth = 800, quality = 0.7) {
  return new Promise((resolve, reject) => {
    try {
      if (!file) {
        reject(new Error('No file provided'));
        return;
      }
      
      const originalName = file.name || 'image.jpg';
      let extension = originalName.split('.').pop() || 'jpg';
      
      const mimeToExt = {
        'image/jpeg': 'jpg',
        'image/png': 'png',
        'image/webp': 'webp',
        'image/gif': 'gif',
        'image/bmp': 'bmp',
      };
      if (file.type && mimeToExt[file.type]) {
        extension = mimeToExt[file.type];
      }
      
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = (event) => {
        try {
          const img = new Image();
          img.src = event.target.result;
          img.onload = () => {
            try {
              let width = img.width;
              let height = img.height;
              if (width > maxWidth) {
                height = (height * maxWidth) / width;
                width = maxWidth;
              }
              const canvas = document.createElement('canvas');
              canvas.width = width;
              canvas.height = height;
              const ctx = canvas.getContext('2d');
              ctx.fillStyle = '#FFFFFF';
              ctx.fillRect(0, 0, width, height);
              ctx.drawImage(img, 0, 0, width, height);
              
              const outputType = extension === 'png' ? 'image/png' : 'image/jpeg';
              const outputQuality = extension === 'png' ? 1 : quality;
              
              canvas.toBlob((blob) => {
                if (blob && blob.size > 0) {
                  const baseName = originalName.replace(/\.[^.]+$/, '');
                  const fileWithName = new File([blob], `${baseName}_compressed.${extension}`, {
                    type: outputType,
                    lastModified: Date.now(),
                  });
                  resolve(fileWithName);
                } else {
                  reject(new Error('Failed to create blob - empty result'));
                }
              }, outputType, outputQuality);
            } catch (err) {
              reject(new Error('Canvas processing error: ' + err.message));
            }
          };
          img.onerror = () => reject(new Error('Failed to load image'));
        } catch (err) {
          reject(new Error('Image loading error: ' + err.message));
        }
      };
      reader.onerror = () => reject(new Error('Failed to read file'));
    } catch (err) {
      reject(new Error('Compression error: ' + err.message));
    }
  });
}

// ============================================================
// ===== STATE =====
// ============================================================
let currentUser = null;
let currentUserProfile = null;
let currentScreen = 'landing';
let activeTab = 'feed';
let showMenu = false;
let showSearchScreen = false;
let searchQuery = '';
let recentSearches = ['Episode 3 drama', 'Team Blue', 'Housemates'];
let showTopButton = false;
let newPostText = '';
let isUploading = false;
let uploadProgress = 0;
let expandedPosts = {};
let selectedImageFiles = [];
let isAdmin = false;

// Viewer states
let viewerType = null;
let viewerPost = null;
let viewerImageIndex = 0;
let viewerImages = [];

let communityPosts = [];
let adminPosts = [];
let feedPosts = [];
let notifications = [];
let notificationCount = 0;
let communitySortMode = 'newest';
let profilePicData = null;
let isDataLoaded = false;
let allUsers = [];
let selectedNotification = null;
let showNotificationDetail = false;

// Admin state
let adminCurrentView = 'dashboard';
let dailyWords = [];
let wordSubmissions = [];
let currentWordGames = [];
let currentWordSubmissionsForMessage = [];

// Housemates state
let housemates = [];
let selectedHousemate = null;
let showHousemateDetail = false;

// Predictions state
let predictions = [];
let userPredictions = {};
let showPredictionDetail = false;

// Ads state
let allAds = [];
let userAds = [];
let approvedAds = [];
let adIndex = 0;
let trackedAdImpressions = new Set();
let adImageCache = {};
let adStatus = 'available';
let impressionQueue = [];
let flushTimeout = null;

// Emoji reactions
let postEmojiReactions = {};
const reactionEmojis = ['🔥', '❤️', '😂', '😱', '👀', '💀', '🎉', '💔', '🤯', '🙌', '👑', '⭐', '😡', '🥺', '🤔', '😎', '🤡', '👻', '🎭', '💎'];
let pendingLikes = new Set();
let flaggedPosts = new Set();
let userFlaggedPosts = new Set();

// Points tracking
let currentUserPoints = 0;

// Comment sheet
let currentCommentPostId = null;
let currentCommentPostType = 'community';
let commentSheetComments = [];
let commentSheetLastDoc = null;
let commentSheetHasMore = true;
let commentSheetIsLoading = false;
let commentSheetReplyingTo = null;
let commentSheetReplyingToUsername = '';

// Reply notification view
let showReplyView = false;
let replyViewData = null;

// Full post view
let showFullPostView = false;
let fullPostData = null;
let fullPostId = null;

// Profile data cache
let profileDataCache = null;
let isProfileLoading = false;

// Scroll position tracking
let savedScrollPositions = {};

// Ads screen state
let showAdsScreen = false;
let showAdDetail = false;
let selectedAdDetail = null;
let selectedAdImageFile = null;

// Ad payment modal state
let pendingAdForPayment = null;

// Delete modal state
let pendingDeleteId = null;
let pendingDeleteType = null;

// Search state
let searchTimeout = null;
let isSearching = false;

// ============================================================
// ===== SETTINGS STATE =====
// ============================================================
let settingsData = {
  pushNotifications: localStorage.getItem('dhouse_push_notif') !== 'false',
  replyNotifications: localStorage.getItem('dhouse_reply_notif') !== 'false',
  tagNotifications: localStorage.getItem('dhouse_tag_notif') !== 'false',
  autoPlay: localStorage.getItem('dhouse_autoplay') !== 'false',
  imageQuality: localStorage.getItem('dhouse_image_quality') || 'medium'
};


// ============================================================
// ===== DOM REFS =====
// ============================================================
const root = document.getElementById('app');

// ============================================================
// ===== GETTER FUNCTIONS =====
// ============================================================

function getAdminPostById(id) {
  return adminPosts.find(p => p.id === id);
}

function getPostById(id) {
  return communityPosts.find(p => p.id === id);
}

function getNotificationById(id) {
  return notifications.find(n => n.id === id);
}



// ============================================================
// ===== LAZY LOADING & INFINITE SCROLLING =====
// ============================================================

let postBatchSize = 15;
let isLoadingMore = false;
let hasMorePosts = true;
let lastVisibleDoc = null;
let postObserver = null;

// ============================================================
// ===== OPTIMIZED DATA LOADER =====
// ============================================================

let isFirstLoad = true;

async function loadPostsOptimized() {
  console.log('📊 Loading posts (optimized)...');
  
  // Enable persistence first
  if (!persistenceEnabled) {
    await enableFirestorePersistence();
  }
  
  // Load community posts
  try {
    const result = await dataManager.getCommunityPosts(isFirstLoad);
    communityPosts = result.data;
    isDataLoaded = true;
    console.log(`📊 Loaded ${communityPosts.length} community posts (${result.fromCache ? 'cache' : 'fresh'})`);
  } catch (error) {
    console.error('Error loading community posts:', error);
  }
  
  // Load feed posts
  try {
    const result = await dataManager.getFeedPosts(isFirstLoad);
    feedPosts = result.data;
    console.log(`📊 Loaded ${feedPosts.length} feed posts (${result.fromCache ? 'cache' : 'fresh'})`);
  } catch (error) {
    console.error('Error loading feed posts:', error);
  }
  
  // Load housemates
  try {
    const result = await dataManager.getHousemates(isFirstLoad);
    housemates = result.data;
    console.log(`🏠 Loaded ${housemates.length} housemates (${result.fromCache ? 'cache' : 'fresh'})`);
  } catch (error) {
    console.error('Error loading housemates:', error);
  }
  
  // Load predictions
  try {
    const result = await dataManager.getPredictions(isFirstLoad);
    predictions = result.data;
    console.log(`🔮 Loaded ${predictions.length} predictions (${result.fromCache ? 'cache' : 'fresh'})`);
  } catch (error) {
    console.error('Error loading predictions:', error);
  }
  
  // ⬇️ ADD WORD GAME LOADING HERE ⬇️
  // Load daily words (word games)
  try {
    const today = new Date().toISOString().split('T')[0];
    const snapshot = await db.collection('daily_words')
      .where('date', '>=', today)
      .orderBy('date', 'asc')
      .get();
    
    currentWordGames = [];
    for (const doc of snapshot.docs) {
      const wordData = { id: doc.id, ...doc.data() };
      if (currentUser) {
        try {
          const subSnapshot = await db.collection('word_submissions')
            .where('wordId', '==', doc.id)
            .where('userId', '==', currentUser.uid)
            .get();
          wordData.userSubmitted = !subSnapshot.empty;
        } catch (e) {
          wordData.userSubmitted = false;
        }
      } else {
        wordData.userSubmitted = false;
      }
      currentWordGames.push(wordData);
    }
    console.log(`🎯 Loaded ${currentWordGames.length} word games`);
  } catch (error) {
    console.error('Error loading word games:', error);
  }
  // ⬆️ END WORD GAME LOADING ⬆️
  
  // Load user predictions if logged in
  if (currentUser) {
    try {
      const result = await dataManager.getUserPredictions(currentUser.uid, isFirstLoad);
      userPredictions = result.data;
      console.log(`🎯 Loaded ${Object.keys(userPredictions).length} user predictions (${result.fromCache ? 'cache' : 'fresh'})`);
    } catch (error) {
      console.error('Error loading user predictions:', error);
    }
  }
  
  // Load ads
  try {
    const result = await dataManager.getAds(isFirstLoad);
    approvedAds = result.data;
    console.log(`📢 Loaded ${approvedAds.length} ads (${result.fromCache ? 'cache' : 'fresh'})`);
  } catch (error) {
    console.error('Error loading ads:', error);
  }
  
  // Load notifications if logged in
  if (currentUser) {
    try {
      const result = await dataManager.getNotifications(currentUser.uid, isFirstLoad);
      notifications = result.data || [];
      notificationCount = notifications.filter(n => !n.read).length;
      console.log(`🔔 Loaded ${notifications.length} notifications (${result.fromCache ? 'cache' : 'fresh'})`);
    } catch (error) {
      console.error('Error loading notifications:', error);
    }
  }
  
  // Setup real-time listeners
  if (currentUser) {
    dataManager.setupRealTimeListeners(currentUser.uid);
  }
  
  isFirstLoad = false;
  
  // Re-render
  if (!isAdmin) {
    renderMainApp();
  } else {
    renderAdminApp();
  }
}

// ============================================================
// ===== LOAD MORE FUNCTIONS =====
// ============================================================

async function loadMoreCommunityPosts() {
  if (isLoadingMore) return;
  isLoadingMore = true;
  
  const btn = document.getElementById('loadMoreCommunityBtn');
  const loadingEl = document.getElementById('loadingMoreCommunity');
  
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ Loading...';
  }
  if (loadingEl) loadingEl.style.display = 'block';
  
  try {
    // Get MORE posts from Firestore (skip the ones we have)
    const currentIds = new Set(communityPosts.map(p => p.id));
    
    // Fetch posts that we DON'T already have
    const snapshot = await db.collection('community_posts')
      .orderBy('createdAt', 'desc')
      .limit(30) // Fetch 30 to make sure we get new ones
      .get();
    
    const newPosts = [];
    snapshot.forEach((doc) => {
      if (!currentIds.has(doc.id)) {
        const data = doc.data();
        newPosts.push({
          id: doc.id,
          user: data.username || data.user || 'Anonymous',
          username: data.username || '@user',
          userId: data.userId || '',
          time: data.createdAt?.toDate?.()?.toLocaleString() || 'Just now',
          content: data.content || '',
          likes: data.likes || 0,
          comments: data.commentCount || data.comments || 0,
          commentCount: data.commentCount || data.comments || 0,
          shares: data.shares || 0,
          liked: data.liked || false,
          tags: data.tags || [],
          images: data.imageUrls || data.images || [],
          emojiReactions: data.emojiReactions || {},
          timestamp: data.createdAt || data.timestamp,
          createdAt: data.createdAt
        });
      }
    });
    
    if (newPosts.length > 0) {
      // Add to existing posts
      communityPosts = [...communityPosts, ...newPosts];
      
      // Update cache
      dataManager.setCache('community_posts', communityPosts);
      
      // Re-render
      if (activeTab === 'community') {
        renderMainApp();
        restoreScrollPosition();
      }
      
      showToast(`📥 Loaded ${newPosts.length} more posts`, true);
    } else {
      showToast('📭 No more posts to load', true);
    }
    
  } catch (error) {
    console.error('Error loading more posts:', error);
    showToast('❌ Failed to load more posts', false);
  }
  
  isLoadingMore = false;
  if (btn) {
    btn.textContent = '📥 Load More Posts';
    btn.disabled = false;
  }
  if (loadingEl) loadingEl.style.display = 'none';
}


async function loadMoreFeedPosts() {
  if (isLoadingMore) return;
  isLoadingMore = true;
  
  const btn = document.getElementById('loadMoreFeedBtn');
  const loadingEl = document.getElementById('loadingMoreFeed');
  
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ Loading...';
  }
  if (loadingEl) loadingEl.style.display = 'block';
  
  try {
    const result = await dataManager.loadMoreFeedPosts(20);
    
    if (result.data && result.data.length > 0) {
      feedPosts = [...feedPosts, ...result.data];
      
      if (activeTab === 'feed') {
        renderMainApp();
        restoreScrollPosition();
      }
      
      showToast(`📥 Loaded ${result.data.length} more feed posts`, true);
    }
    
    if (!result.hasMore || result.allLoaded) {
      if (btn) {
        btn.textContent = '✅ All feed posts loaded';
        btn.disabled = true;
      }
    } else {
      if (btn) {
        btn.textContent = `📥 Load More Feed Posts`;
        btn.disabled = false;
      }
    }
  } catch (error) {
    console.error('Error loading more feed posts:', error);
    showToast('❌ Failed to load more feed posts', false);
    if (btn) {
      btn.textContent = '🔄 Try Again';
      btn.disabled = false;
    }
  }
  
  isLoadingMore = false;
  if (loadingEl) loadingEl.style.display = 'none';
}

// ============================================================
// ===== REFRESH DATA (Pull to refresh) =====
// ============================================================

async function refreshAllData() {
  console.log('🔄 Refreshing all data...');
  showToast('🔄 Refreshing data...', true);
  
  try {
    // Invalidate all cache
    dataManager.invalidateAllCache();
    
    // Reset pagination
    dataManager.resetPagination('community_posts');
    dataManager.resetPagination('feed_posts');
    
    // Reload data
    isFirstLoad = true;
    await loadPostsOptimized();
    
    showToast('✅ Data refreshed!', true);
  } catch (error) {
    console.error('Error refreshing data:', error);
    showToast('❌ Failed to refresh data', false);
  }
}

// ============================================================
// ===== TOAST FUNCTION =====
// ============================================================
function showToast(message, isSuccess = true) {
  const toast = document.createElement('div');
  toast.style.cssText = `
    position: fixed;
    bottom: 80px;
    left: 50%;
    transform: translateX(-50%);
    background: ${isSuccess ? 'rgba(0,0,0,0.9)' : 'rgba(229,57,53,0.9)'};
    color: ${isSuccess ? '#FFB300' : 'white'};
    padding: 12px 24px;
    border-radius: 12px;
    font-size: 14px;
    z-index: 9999;
    border: 1px solid ${isSuccess ? '#e94560' : '#ff6b6b'};
    box-shadow: 0 4px 20px rgba(0,0,0,0.5);
    backdrop-filter: blur(10px);
    font-weight: bold;
    max-width: 90%;
    text-align: center;
    animation: slideUp 0.3s ease-out;
  `;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// ============================================================
// ===== SAVE SCROLL POSITION =====
// ============================================================
function saveScrollPosition() {
  const contentArea = document.getElementById('contentArea');
  if (contentArea) {
    savedScrollPositions[activeTab] = contentArea.scrollTop;
  }
}

function restoreScrollPosition() {
  const contentArea = document.getElementById('contentArea');
  if (contentArea && savedScrollPositions[activeTab] !== undefined) {
    setTimeout(() => {
      contentArea.scrollTop = savedScrollPositions[activeTab];
    }, 50);
  }
}

// ============================================================
// ===== ESCAPE HTML =====
// ============================================================
function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ============================================================
// ===== POINTS SYSTEM =====
// ============================================================

async function awardPointsForInteraction(userId, postId, action) {
  if (!userId) return;
  const interactionKey = `interacted_${postId}_${userId}`;
  if (localStorage.getItem(interactionKey)) return;
  
  try {
    const userRef = db.collection('users').doc(userId);
    await userRef.update({
      totalPoints: firebase.firestore.FieldValue.increment(POINTS_PER_INTERACTION)
    });
    localStorage.setItem(interactionKey, 'true');
    if (userId === currentUser?.uid) {
      currentUserPoints += POINTS_PER_INTERACTION;
    }
    console.log(`✅ +${POINTS_PER_INTERACTION} points for ${action}`);
  } catch (error) {
    console.error('Error awarding points:', error);
  }
}

async function removePointsForInteraction(userId, postId) {
  if (!userId) return;
  const interactionKey = `interacted_${postId}_${userId}`;
  if (!localStorage.getItem(interactionKey)) return;
  
  try {
    const userRef = db.collection('users').doc(userId);
    await userRef.update({
      totalPoints: firebase.firestore.FieldValue.increment(-POINTS_PER_INTERACTION)
    });
    localStorage.removeItem(interactionKey);
    if (userId === currentUser?.uid) {
      currentUserPoints = Math.max(0, currentUserPoints - POINTS_PER_INTERACTION);
    }
    console.log(`➖ -${POINTS_PER_INTERACTION} points removed`);
  } catch (error) {
    console.error('Error removing points:', error);
  }
}


// ============================================================
// ===== FEED POST REACTIONS =====
// ============================================================

async function addReactionToFeedPost(postId, emoji) {
  if (!currentUser) {
    showToast('Please sign in to react', false);
    return;
  }
  
  const post = feedPosts.find(p => p.id === postId);
  if (!post) {
    showToast('Post not found. Please refresh and try again.', false);
    return;
  }
  
  const userId = currentUser.uid;
  const reactionKey = `feed_reaction_${postId}_${userId}`;
  const existingReaction = localStorage.getItem(reactionKey);
  
  try {
    const postRef = db.collection('feed_posts').doc(postId);
    const postDoc = await postRef.get();
    
    if (!postDoc.exists) {
      showToast('Post not found in database.', false);
      return;
    }
    
    if (existingReaction === emoji) {
      await postRef.update({
        [`reactions.${emoji}`]: firebase.firestore.FieldValue.increment(-1)
      });
      localStorage.removeItem(reactionKey);
      if (post.reactions && post.reactions[emoji]) {
        post.reactions[emoji] = Math.max(0, post.reactions[emoji] - 1);
      }
      await removePointsForInteraction(userId, postId);
      showToast('Reaction removed', true);
    } else {
      const updateData = {};
      if (existingReaction) {
        updateData[`reactions.${existingReaction}`] = firebase.firestore.FieldValue.increment(-1);
        if (post.reactions && post.reactions[existingReaction]) {
          post.reactions[existingReaction] = Math.max(0, post.reactions[existingReaction] - 1);
        }
      }
      updateData[`reactions.${emoji}`] = firebase.firestore.FieldValue.increment(1);
      await postRef.update(updateData);
      localStorage.setItem(reactionKey, emoji);
      
      if (!post.reactions) post.reactions = {};
      post.reactions[emoji] = (post.reactions[emoji] || 0) + 1;
      
      await awardPointsForInteraction(userId, postId, 'reacting to feed post');
      showToast(`Reacted with ${emoji}! +10 points`, true);
    }
    renderMainApp();
    restoreScrollPosition();
  } catch (error) {
    console.error('Error adding reaction:', error);
    showToast('Failed to add reaction. Please try again.', false);
  }
}

// ============================================================
// ===== NOTIFICATION FUNCTIONS =====
// ============================================================

async function markNotificationRead(notifId) {
  try {
    await db.collection('notifications').doc(notifId).update({ read: true });
    // Update cache
    dataManager.invalidateCache(`notifications_${currentUser?.uid}`);
    return true;
  } catch (error) {
    console.error('Error marking notification:', error);
    return false;
  }
}

async function markAllNotificationsRead() {
  try {
    const batch = db.batch();
    notifications.forEach(n => {
      if (!n.read) {
        const ref = db.collection('notifications').doc(n.id);
        batch.update(ref, { read: true });
      }
    });
    await batch.commit();
    dataManager.invalidateCache(`notifications_${currentUser?.uid}`);
    return true;
  } catch (error) {
    console.error('Error marking all as read:', error);
    return false;
  }
}

async function addNotification(notificationData) {
  try {
    await db.collection('notifications').add({
      type: notificationData.type || 'tag',
      from: notificationData.from,
      to: notificationData.to,
      fromName: notificationData.fromName || 'Someone',
      message: notificationData.message,
      read: false,
      time: 'Just now',
      timestamp: firebase.firestore.FieldValue.serverTimestamp(),
      postId: notificationData.postId || '',
      commentId: notificationData.commentId || '',
      parentCommentId: notificationData.parentCommentId || '',
      replyText: notificationData.replyText || ''
    });
    dataManager.invalidateCache(`notifications_${currentUser?.uid}`);
    return true;
  } catch (error) {
    console.error('Error adding notification:', error);
    return false;
  }
}

// ============================================================
// ===== EMOJI REACTIONS =====
// ============================================================

function loadUserReactions() {
  const saved = localStorage.getItem('dhouse_emoji_reactions');
  if (saved) {
    try { postEmojiReactions = JSON.parse(saved); } catch (e) { console.error(e); }
  }
}

function saveUserReactions() {
  localStorage.setItem('dhouse_emoji_reactions', JSON.stringify(postEmojiReactions));
}

async function addEmojiReaction(postId, emoji) {
  const userId = currentUser?.uid;
  if (!userId) {
    showToast('Please sign in to react', false);
    closeEmojiPicker();
    return;
  }
  
  const postRef = db.collection('community_posts').doc(postId);
  const userReactionKey = `emoji_${postId}_${userId}`;
  const existingReaction = postEmojiReactions[userReactionKey];
  
  try {
    const postDoc = await postRef.get();
    if (!postDoc.exists) {
      showToast('Post not found', false);
      closeEmojiPicker();
      return;
    }
    
    await db.runTransaction(async (transaction) => {
      const doc = await transaction.get(postRef);
      if (!doc.exists) {
        throw new Error('Post does not exist!');
      }
      
      const data = doc.data();
      const emojiReactions = data.emojiReactions || {};
      
      if (existingReaction === emoji) {
        const currentCount = (emojiReactions[emoji]?.count || 0);
        if (currentCount > 0) {
          if (currentCount === 1) {
            delete emojiReactions[emoji];
          } else {
            emojiReactions[emoji].count = currentCount - 1;
          }
        }
        transaction.update(postRef, { emojiReactions: emojiReactions });
        delete postEmojiReactions[userReactionKey];
        await removePointsForInteraction(userId, postId);
        showToast('Reaction removed', true);
      } else {
        if (existingReaction) {
          const existingCount = (emojiReactions[existingReaction]?.count || 0);
          if (existingCount > 0) {
            if (existingCount === 1) {
              delete emojiReactions[existingReaction];
            } else {
              emojiReactions[existingReaction].count = existingCount - 1;
            }
          }
        }
        if (!emojiReactions[emoji]) {
          emojiReactions[emoji] = { count: 0 };
        }
        emojiReactions[emoji].count = (emojiReactions[emoji].count || 0) + 1;
        
        transaction.update(postRef, { emojiReactions: emojiReactions });
        postEmojiReactions[userReactionKey] = emoji;
        await awardPointsForInteraction(userId, postId, 'reacting with emoji');
        
        logEvent('emoji_reaction', {
          post_id: postId,
          emoji: emoji,
          action: 'added'
        });
        
        showToast(`Reacted with ${emoji}! +10 points`, true);
      }
    });
    
    saveUserReactions();
    
    // Update local data
    const localPost = communityPosts.find(p => p.id === postId);
    if (localPost) {
      const freshPost = await postRef.get();
      if (freshPost.exists) {
        localPost.emojiReactions = freshPost.data().emojiReactions || {};
      }
    }
    
    if (showFullPostView) {
      renderFullPostView();
    } else {
      renderMainApp();
      restoreScrollPosition();
    }
  } catch (error) {
    console.error('Error adding emoji reaction:', error);
    showToast('Failed to add reaction. Please try again.', false);
  }
  closeEmojiPicker();
}

// ============================================================
// ===== FEED POST EMOJI REACTIONS =====
// ============================================================

async function addFeedEmojiReaction(postId, emoji) {
  const userId = currentUser?.uid;
  if (!userId) {
    showToast('Please sign in to react', false);
    closeEmojiPicker();
    return;
  }
  
  const postRef = db.collection('feed_posts').doc(postId);
  const userReactionKey = `feed_emoji_${postId}_${userId}`;
  const existingReaction = postEmojiReactions[userReactionKey];

  try {
    const postDoc = await postRef.get();
    if (!postDoc.exists) {
      showToast('Post not found', false);
      closeEmojiPicker();
      return;
    }
    
    await db.runTransaction(async (transaction) => {
      const doc = await transaction.get(postRef);
      if (!doc.exists) {
        throw new Error('Post does not exist!');
      }
      
      const data = doc.data();
      const emojiReactions = data.emojiReactions || {};
      
      if (existingReaction === emoji) {
        const currentCount = (emojiReactions[emoji]?.count || 0);
        if (currentCount > 0) {
          if (currentCount === 1) {
            delete emojiReactions[emoji];
          } else {
            emojiReactions[emoji].count = currentCount - 1;
          }
        }
        transaction.update(postRef, { emojiReactions: emojiReactions });
        delete postEmojiReactions[userReactionKey];
        await removePointsForInteraction(userId, postId);
        showToast('Reaction removed', true);
      } else {
        if (existingReaction) {
          const existingCount = (emojiReactions[existingReaction]?.count || 0);
          if (existingCount > 0) {
            if (existingCount === 1) {
              delete emojiReactions[existingReaction];
            } else {
              emojiReactions[existingReaction].count = existingCount - 1;
            }
          }
        }
        if (!emojiReactions[emoji]) {
          emojiReactions[emoji] = { count: 0 };
        }
        emojiReactions[emoji].count = (emojiReactions[emoji].count || 0) + 1;
        
        transaction.update(postRef, { emojiReactions: emojiReactions });
        postEmojiReactions[userReactionKey] = emoji;
        await awardPointsForInteraction(userId, postId, 'reacting with emoji on feed');
        showToast(`Reacted with ${emoji}! +10 points`, true);
      }
    });
    
    saveUserReactions();
    
    const localPost = feedPosts.find(p => p.id === postId);
    if (localPost) {
      const freshPost = await postRef.get();
      if (freshPost.exists) {
        localPost.emojiReactions = freshPost.data().emojiReactions || {};
      }
    }
    
    if (showFullPostView) {
      renderFullPostView();
    } else {
      renderMainApp();
      restoreScrollPosition();
    }
  } catch (error) {
    console.error('Error adding emoji reaction to feed post:', error);
    showToast('Failed to add reaction. Please try again.', false);
  }
  closeEmojiPicker();
}

function showEmojiPicker(postId, event) {
  if (event) {
    event.stopPropagation();
    event.preventDefault();
  }
  
  if (!currentUser) {
    showToast('Please sign in to react', false);
    return;
  }
  
  const modal = document.getElementById('emojiPickerModal');
  const grid = document.getElementById('emojiPickerGrid');
  
  if (modal && grid) {
    let emojiHtml = '';
    for (const emoji of reactionEmojis) {
      emojiHtml += `<button onclick="addEmojiReaction('${postId}', '${emoji}')">${emoji}</button>`;
    }
    grid.innerHTML = emojiHtml;
    modal.style.display = 'flex';
  }
}

function showFeedEmojiPicker(postId, event) {
  if (event) {
    event.stopPropagation();
    event.preventDefault();
  }
  
  if (!currentUser) {
    showToast('Please sign in to react', false);
    return;
  }
  
  const modal = document.getElementById('emojiPickerModal');
  const grid = document.getElementById('emojiPickerGrid');
  
  if (modal && grid) {
    let emojiHtml = '';
    for (const emoji of reactionEmojis) {
      emojiHtml += `<button onclick="addFeedEmojiReaction('${postId}', '${emoji}')">${emoji}</button>`;
    }
    grid.innerHTML = emojiHtml;
    modal.style.display = 'flex';
  }
}

function closeEmojiPicker() {
  const modal = document.getElementById('emojiPickerModal');
  if (modal) {
    modal.style.display = 'none';
  }
}

// ============================================================
// ===== FIRESTORE FUNCTIONS (Legacy support) =====
// ============================================================

function loadPosts() {
  // This is now replaced by loadPostsOptimized()
  // Kept for backward compatibility
  loadPostsOptimized();
}

// ============================================================
// ===== AD FUNCTIONS =====
// ============================================================

function generateUniqueCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 12; i++) {
    if (i > 0 && i % 4 === 0) code += '-';
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

async function createAdRequest(adData) {
  try {
    const uniqueCode = generateUniqueCode();
    await db.collection('ads').add({
      userId: currentUser.uid,
      businessName: adData.businessName,
      imageUrl: adData.imageUrl,
      amount: adData.budget,
      budgetLeft: 0,
      totalImpressions: 0,
      uniqueCode: uniqueCode,
      status: 'pending_payment',
      targetLocation: adData.targetLocation || false,
      country: adData.country || '',
      state: adData.state || '',
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      dailyImpressions: {},
      paymentVerified: false
    });
    dataManager.invalidateCache('ads');
    showToast('✅ Ad request created! Please complete payment.', true);
    return uniqueCode;
  } catch (error) {
    console.error('Error creating ad:', error);
    showToast('❌ Failed to create ad request.', false);
    return null;
  }
}

function showPaymentModal(uniqueCode, businessName, amount) {
  const existingModal = document.querySelector('.payment-modal-overlay');
  if (existingModal) existingModal.remove();
  
  const modal = document.createElement('div');
  modal.className = 'payment-modal-overlay';
  modal.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0,0,0,0.85);
    z-index: 10000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
  `;
  
  modal.innerHTML = `
    <div style="background:#1a1a2e;border-radius:24px;padding:2rem;max-width:400px;width:100%;border:1px solid #2a2a4e;position:relative;max-height:90vh;overflow-y:auto;">
      <button onclick="closePaymentModal()" style="position:absolute;top:12px;right:16px;background:none;border:none;color:#a7a9be;font-size:1.5rem;cursor:pointer;">✕</button>
      
      <div style="text-align:center;margin-bottom:1.5rem;">
        <span style="font-size:3rem;display:block;">💰</span>
        <h2 style="color:#fffffe;font-size:1.3rem;">Complete Payment</h2>
        <p style="color:#a7a9be;font-size:0.9rem;">${escapeHtml(businessName)}</p>
      </div>
      
      <div style="background:#0f0e17;border-radius:16px;padding:1.5rem;border:1px solid #2a2a4e;margin-bottom:1.5rem;">
        <div style="text-align:center;margin-bottom:1rem;">
          <div style="color:#6b7280;font-size:0.8rem;">Amount to Pay</div>
          <div style="color:#FFB300;font-size:2rem;font-weight:bold;">₦${(amount || 0).toLocaleString()}</div>
        </div>
        
        <div style="background:#0f0e17;border-radius:12px;padding:1rem;border:1px solid #2a2a4e;margin-bottom:1rem;">
          <div style="color:#6b7280;font-size:0.7rem;text-align:center;margin-bottom:0.3rem;">Send to:</div>
          <div style="text-align:center;">
            <div style="color:#fffffe;font-size:1.2rem;font-weight:600;">${OPAY_ACCOUNT}</div>
            <div style="color:#FFB300;font-size:0.9rem;">${OPAY_ACCOUNT_NAME}</div>
            <div style="color:#6b7280;font-size:0.8rem;">${OPAY_BANK}</div>
          </div>
        </div>
        
        <div style="background:#0f0e17;border-radius:12px;padding:1rem;border:1px solid #e94560;">
          <div style="color:#6b7280;font-size:0.7rem;text-align:center;margin-bottom:0.3rem;">📋 Unique Code (Copy & Paste in Remark)</div>
          <div style="display:flex;align-items:center;justify-content:center;gap:0.5rem;">
            <code style="color:#FFB300;font-size:1.1rem;font-weight:bold;letter-spacing:1px;background:#0f0e17;padding:0.3rem 0.8rem;border-radius:6px;border:1px solid #2a2a4e;">${uniqueCode}</code>
            <button onclick="copyUniqueCode('${uniqueCode}')" style="background:#e94560;border:none;color:white;padding:0.3rem 0.8rem;border-radius:6px;cursor:pointer;font-size:0.8rem;">📋 Copy</button>
          </div>
          <div style="color:#6b7280;font-size:0.6rem;text-align:center;margin-top:0.3rem;">Use this code as the remark/reason for transfer</div>
        </div>
      </div>
      
      <div style="background:#0f0e17;border-radius:12px;padding:1rem;border:1px solid #2a2a4e;margin-bottom:1.5rem;">
        <div style="color:#a7a9be;font-size:0.8rem;line-height:1.5;">
          <strong style="color:#fffffe;">Instructions:</strong>
          <ol style="padding-left:1.2rem;margin-top:0.3rem;color:#a7a9be;">
            <li>Open your <strong>Opay</strong> app</li>
            <li>Send <strong>₦${(amount || 0).toLocaleString()}</strong> to <strong>${OPAY_ACCOUNT}</strong></li>
            <li>In the <strong>remark/message</strong> field, paste the <strong>Unique Code</strong> above</li>
            <li>Complete the transfer</li>
            <li>Wait for admin approval</li>
          </ol>
        </div>
      </div>
      
      <button onclick="closePaymentModal()" style="width:100%;padding:0.8rem;background:#2a2a4e;border:none;border-radius:12px;color:#fffffe;font-weight:600;cursor:pointer;font-size:1rem;">
        I've Made the Payment
      </button>
    </div>
  `;
  
  document.body.appendChild(modal);
}

function closePaymentModal() {
  const modal = document.querySelector('.payment-modal-overlay');
  if (modal) modal.remove();
}

function copyUniqueCode(code) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(code).then(() => {
      showToast('✅ Unique code copied! Paste it in your OPay remark.', true);
    }).catch(() => {
      fallbackCopyUniqueCode(code);
    });
  } else {
    fallbackCopyUniqueCode(code);
  }
}

function fallbackCopyUniqueCode(code) {
  const input = document.createElement('input');
  input.value = code;
  document.body.appendChild(input);
  input.select();
  try {
    document.execCommand('copy');
    showToast('✅ Unique code copied! Paste it in your OPay remark.', true);
  } catch (e) {
    showToast('❌ Failed to copy. Please copy manually: ' + code, false);
  }
  document.body.removeChild(input);
}

async function verifyAdPayment(adId) {
  if (!confirm('Confirm that payment has been received and the unique code matches?')) {
    return;
  }
  
  try {
    const adRef = db.collection('ads').doc(adId);
    const adDoc = await adRef.get();
    if (!adDoc.exists) {
      showToast('Ad not found.', false);
      return;
    }
    
    const adData = adDoc.data();
    
    await adRef.update({
      status: 'approved',
      paymentVerified: true,
      budgetLeft: adData.amount || 0,
      approvedAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    
    dataManager.invalidateCache('ads');
    showToast('✅ Payment verified and ad approved!', true);
    renderAdminApp();
  } catch (error) {
    console.error('Error verifying payment:', error);
    showToast('❌ Failed to verify payment.', false);
  }
}

function getNextAd() {
  if (approvedAds.length === 0) return null;
  const availableAds = approvedAds.filter(ad => (ad.budgetLeft || 0) > 0);
  if (availableAds.length === 0) return null;
  const ad = availableAds[adIndex % availableAds.length];
  adIndex++;
  return ad;
}

async function trackAdDisplay(adId) {
  if (trackedAdImpressions.has(adId)) return;
  trackedAdImpressions.add(adId);
  impressionQueue.push({ adId, timestamp: Date.now() });
  if (impressionQueue.length >= 10) {
    await flushImpressions();
  } else {
    clearTimeout(flushTimeout);
    flushTimeout = setTimeout(flushImpressions, 5000);
  }
}

async function flushImpressions() {
  if (impressionQueue.length === 0) return;
  const batch = db.batch();
  const counts = {};
  for (const imp of impressionQueue) {
    counts[imp.adId] = (counts[imp.adId] || 0) + 1;
  }
  for (const [adId, count] of Object.entries(counts)) {
    try {
      const adRef = db.collection('ads').doc(adId);
      const adDoc = await adRef.get();
      if (!adDoc.exists) {
        const idx = approvedAds.findIndex(a => a.id === adId);
        if (idx !== -1) approvedAds.splice(idx, 1);
        continue;
      }
      const data = adDoc.data();
      const currentBudget = data.budgetLeft || 0;
      const cost = count * COST_PER_IMPRESSION;
      if (currentBudget <= cost) {
        batch.delete(adRef);
        const idx = approvedAds.findIndex(a => a.id === adId);
        if (idx !== -1) approvedAds.splice(idx, 1);
        continue;
      }
      const today = new Date().toISOString().split('T')[0];
      const dailyImps = data.dailyImpressions || {};
      dailyImps[today] = (dailyImps[today] || 0) + count;
      batch.update(adRef, {
        budgetLeft: currentBudget - cost,
        totalImpressions: (data.totalImpressions || 0) + count,
        dailyImpressions: dailyImps
      });
      const ad = approvedAds.find(a => a.id === adId);
      if (ad) {
        ad.budgetLeft = currentBudget - cost;
        ad.totalImpressions = (ad.totalImpressions || 0) + count;
        if (ad.budgetLeft <= 0) {
          const idx = approvedAds.findIndex(a => a.id === adId);
          if (idx !== -1) approvedAds.splice(idx, 1);
        }
      }
    } catch (error) {
      console.error('Error processing impression batch:', error);
    }
  }
  await batch.commit();
  impressionQueue = [];
  console.log(`📊 Flushed ${Object.keys(counts).length} ad impressions`);
}

// ============================================================
// ===== RENDER AD BANNER =====
// ============================================================
function renderAdBanner(ad) {
  if (!ad) return '';
  setTimeout(() => {
    trackAdDisplay(ad.id);
    logEvent('ad_impression', {
      ad_id: ad.id,
      business_name: ad.businessName
    });
  }, 100);
  
  return `
    <div class="ad-banner" onclick="handleAdClick('${ad.id}')" style="
      background: #1A1A1A;
      border-radius: 16px;
      padding: 16px;
      margin-bottom: 16px;
      border: 1px solid #2A2A2A;
      position: relative;
      cursor: pointer;
      transition: all 0.2s ease;
      overflow: hidden;
      width: 100%;
    ">
      <div style="
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 12px;
      ">
        <span style="
          background: rgba(229,57,53,0.15);
          color: #E53935;
          font-size: 10px;
          font-weight: 600;
          padding: 2px 12px;
          border-radius: 20px;
          letter-spacing: 0.5px;
        ">📢 SPONSORED</span>
        <span style="
          font-size: 10px;
          color: #666;
          margin-left: auto;
        ">Ad</span>
      </div>
      
      <div style="
        border-radius: 12px;
        overflow: hidden;
        margin-bottom: 12px;
        background: #0A0A0A;
      ">
        <img src="${ad.imageUrl}" alt="${ad.businessName}" style="
          width: 100%;
          height: auto;
          max-height: 350px;
          object-fit: contain;
          display: block;
          background: #0A0A0A;
        ">
      </div>
      
      <div style="
        font-size: 15px;
        font-weight: 600;
        color: #fff;
        margin-bottom: 2px;
      ">${ad.businessName}</div>
      
      <div style="
        font-size: 12px;
        color: #888;
      ">Sponsored content · Learn more</div>
    </div>
  `;
}

function handleAdClick(adId) {
  showToast(`📢 ${approvedAds.find(a => a.id === adId)?.businessName || 'Ad'} - Thanks for your interest!`, true);
}

// ============================================================
// ===== PREDICTION FUNCTIONS =====
// ============================================================

function getTimeLeft(endDate) {
  const diff = endDate - new Date();
  if (diff <= 0) return '';
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  if (hours > 24) {
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h left`;
  }
  if (hours > 0) return `${hours}h ${minutes}m left`;
  return `${minutes}m left`;
}

async function submitPrediction(predictionId) {
  if (!currentUser) {
    showToast('Please sign in to vote.', false);
    return;
  }
  
  if (userPredictions[predictionId]) {
    showToast('You already voted on this prediction.', false);
    return;
  }
  
  const select = document.getElementById(`pred_select_${predictionId}`);
  if (!select) {
    showToast('Please select an option.', false);
    return;
  }
  
  const selectedOption = select.value;
  if (!selectedOption) {
    showToast('Please select an option from the dropdown.', false);
    return;
  }
  
  try {
    await db.collection('user_predictions').add({
      userId: currentUser.uid,
      predictionId: predictionId,
      selectedOption: selectedOption,
      votedAt: firebase.firestore.FieldValue.serverTimestamp(),
      isCorrect: false
    });
    dataManager.invalidateCache(`user_predictions_${currentUser.uid}`);
    showToast('✅ Prediction submitted!', true);
    await awardPointsForInteraction(currentUser.uid, predictionId, 'making a prediction');
    renderMainApp();
    restoreScrollPosition();
  } catch (error) {
    console.error('Error submitting prediction:', error);
    showToast('Failed to submit prediction.', false);
  }
}

// ============================================================
// ===== ADMIN FUNCTIONS =====
// ============================================================

async function loadAllUsers() {
  try {
    const result = await dataManager.getAllUsers();
    allUsers = result.data || [];
    return allUsers;
  } catch (error) {
    console.error('Error loading users:', error);
    return [];
  }
}

async function sendNotificationToAll(message) {
  if (!message.trim()) return false;
  try {
    const users = await loadAllUsers();
    const batch = db.batch();
    users.forEach(user => {
      const ref = db.collection('notifications').doc();
      batch.set(ref, {
        type: 'admin',
        from: 'admin',
        fromName: 'DHouse Admin',
        to: user.id,
        message: message,
        read: false,
        time: 'Just now',
        timestamp: firebase.firestore.FieldValue.serverTimestamp()
      });
    });
    await batch.commit();
    dataManager.invalidateCache(`notifications_${currentUser?.uid}`);
    return true;
  } catch (error) {
    console.error('Error sending notification to all:', error);
    return false;
  }
}

async function sendNotificationToUser(uid, message) {
  if (!message.trim() || !uid) return false;
  try {
    await db.collection('notifications').add({
      type: 'admin',
      from: 'admin',
      fromName: 'DHouse Admin',
      to: uid,
      message: message,
      read: false,
      time: 'Just now',
      timestamp: firebase.firestore.FieldValue.serverTimestamp()
    });
    dataManager.invalidateCache(`notifications_${uid}`);
    return true;
  } catch (error) {
    console.error('Error sending notification to user:', error);
    return false;
  }
}

async function sendNotificationToList(uidList, message) {
  if (!message.trim() || !uidList || uidList.length === 0) return false;
  try {
    const batch = db.batch();
    uidList.forEach(uid => {
      const ref = db.collection('notifications').doc();
      batch.set(ref, {
        type: 'admin',
        from: 'admin',
        fromName: 'DHouse Admin',
        to: uid,
        message: message,
        read: false,
        time: 'Just now',
        timestamp: firebase.firestore.FieldValue.serverTimestamp()
      });
    });
    await batch.commit();
    uidList.forEach(uid => {
      dataManager.invalidateCache(`notifications_${uid}`);
    });
    return true;
  } catch (error) {
    console.error('Error sending notification to list:', error);
    return false;
  }
}

async function deleteUserAccount(uid) {
  if (!confirm('Are you sure you want to delete this user? This cannot be undone!')) {
    return false;
  }
  try {
    await db.collection('users').doc(uid).delete();
    const notifSnapshot = await db.collection('notifications').where('to', '==', uid).get();
    const batch = db.batch();
    notifSnapshot.forEach(doc => {
      batch.delete(doc.ref);
    });
    await batch.commit();
    dataManager.invalidateCache('all_users');
    dataManager.invalidateCache(`notifications_${uid}`);
    alert('✅ User deleted successfully!');
    await loadAllUsers();
    renderAdminApp();
    return true;
  } catch (error) {
    console.error('Error deleting user:', error);
    alert('❌ Failed to delete user.');
    return false;
  }
}

async function getFlaggedPosts() {
  try {
    const snapshot = await db.collection('flagged_posts').orderBy('flaggedAt', 'desc').get();
    const flagged = [];
    snapshot.forEach(doc => {
      flagged.push({ id: doc.id, ...doc.data() });
    });
    return flagged;
  } catch (error) {
    console.error('Error getting flagged posts:', error);
    return [];
  }
}

async function resolveFlaggedPost(flagId) {
  try {
    await db.collection('flagged_posts').doc(flagId).delete();
    showToast('✅ Flagged post resolved!', true);
    return true;
  } catch (error) {
    console.error('Error resolving flagged post:', error);
    showToast('Failed to resolve flagged post.', false);
    return false;
  }
}

// ============================================================
// ===== SUBMIT FEEDBACK TO FIRESTORE =====
// ============================================================

async function submitFeedback(userId, username, email, message, type = 'feedback') {
  try {
    await db.collection('feedback').add({
      userId: userId || 'anonymous',
      username: username || 'Anonymous',
      email: email || '',
      message: message,
      type: type,
      status: 'pending',
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    return true;
  } catch (error) {
    console.error('Error submitting feedback:', error);
    return false;
  }
}

// ============================================================
// ===== FLAG POST =====
// ============================================================

async function toggleFlagPost(postId, event) {
  if (event) {
    event.stopPropagation();
    event.preventDefault();
  }
  
  const userId = currentUser?.uid;
  if (!userId) {
    showToast('Please sign in to flag a post.', false);
    return;
  }
  
  if (userFlaggedPosts.has(postId)) {
    if (confirm('Remove your flag from this post?')) {
      try {
        const snapshot = await db.collection('flagged_posts')
          .where('postId', '==', postId)
          .where('userId', '==', userId)
          .get();
        
        const batch = db.batch();
        snapshot.forEach(doc => {
          batch.delete(doc.ref);
        });
        await batch.commit();
        
        userFlaggedPosts.delete(postId);
        flaggedPosts.delete(postId);
        showToast('✅ Flag removed.', true);
        renderMainApp();
      } catch (error) {
        console.error('Error unflagging post:', error);
        showToast('Failed to remove flag.', false);
      }
    }
    return;
  }
  
  const reason = prompt('Why are you flagging this post? (Optional)');
  if (reason === null) return;
  
  try {
    await db.collection('flagged_posts').add({
      postId: postId,
      userId: userId,
      reason: reason || 'Inappropriate content',
      flaggedAt: firebase.firestore.FieldValue.serverTimestamp(),
      username: currentUser?.displayName || 'Anonymous'
    });
    userFlaggedPosts.add(postId);
    flaggedPosts.add(postId);
    showToast('🚩 Post flagged for review. Admin will take action.', true);
    renderMainApp();
  } catch (error) {
    console.error('Error flagging post:', error);
    showToast('Failed to flag post. Please try again.', false);
  }
}

async function loadFlaggedPostsStatus() {
  try {
    const snapshot = await db.collection('flagged_posts').get();
    flaggedPosts = new Set();
    userFlaggedPosts = new Set();
    const userId = currentUser?.uid;
    
    snapshot.forEach(doc => {
      const data = doc.data();
      flaggedPosts.add(data.postId);
      if (userId && data.userId === userId) {
        userFlaggedPosts.add(data.postId);
      }
    });
    console.log(`📋 Loaded ${flaggedPosts.size} flagged posts, ${userFlaggedPosts.size} by user`);
  } catch (error) {
    console.error('Error loading flagged posts:', error);
  }
}

async function deleteUserPost(postId, event) {
  if (event) {
    event.stopPropagation();
    event.preventDefault();
  }
  
  const userId = currentUser?.uid;
  const post = communityPosts.find(p => p.id === postId);
  
  if (!post) {
    showToast('Post not found.', false);
    return;
  }
  
  if (post.userId !== userId && !isAdmin) {
    showToast('You can only delete your own posts.', false);
    return;
  }
  
  if (!confirm('Are you sure you want to delete this post? This cannot be undone!')) {
    return;
  }
  
  try {
    await db.collection('community_posts').doc(postId).delete();
    const flagsSnapshot = await db.collection('flagged_posts').where('postId', '==', postId).get();
    const batch = db.batch();
    flagsSnapshot.forEach(doc => {
      batch.delete(doc.ref);
    });
    await batch.commit();
    
    dataManager.invalidateCache('community_posts');
    showToast('✅ Post deleted successfully!', true);
    renderMainApp();
  } catch (error) {
    console.error('Error deleting post:', error);
    showToast('Failed to delete post.', false);
  }
}

// ============================================================
// ===== HOUSEMATE FUNCTIONS =====
// ============================================================

async function addHousemate(housemateData) {
  try {
    await db.collection('housemates').add({
      name: housemateData.name,
      state: housemateData.state || '',
      occupation: housemateData.occupation || '',
      sex: housemateData.sex || 'male',
      age: parseInt(housemateData.age) || 0,
      biography: housemateData.biography || '',
      avatarUrl: housemateData.avatarUrl || '',
      status: housemateData.status || 'in-game',
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    dataManager.invalidateCache('housemates');
    showToast('✅ Housemate added successfully!', true);
    return true;
  } catch (error) {
    console.error('Error adding housemate:', error);
    showToast('❌ Failed to add housemate.', false);
    return false;
  }
}

async function deleteHousemate(housemateId) {
  if (!confirm('Are you sure you want to delete this housemate? This cannot be undone!')) {
    return false;
  }
  try {
    await db.collection('housemates').doc(housemateId).delete();
    dataManager.invalidateCache('housemates');
    showToast('✅ Housemate deleted successfully!', true);
    return true;
  } catch (error) {
    console.error('Error deleting housemate:', error);
    showToast('❌ Failed to delete housemate.', false);
    return false;
  }
}

async function updateHousemateStatus(housemateId, status) {
  try {
    await db.collection('housemates').doc(housemateId).update({
      status: status,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    dataManager.invalidateCache('housemates');
    showToast(`✅ Status updated to ${status === 'in-game' ? 'In Game' : 'Evicted'}!`, true);
    return true;
  } catch (error) {
    console.error('Error updating housemate status:', error);
    showToast('❌ Failed to update status.', false);
    return false;
  }
}

function getHousemateAvatar(sex) {
  if (sex === 'female') {
    return '👩';
  } else {
    return '👨';
  }
}

function openHousemateDetail(housemateId) {
  const housemate = housemates.find(h => h.id === housemateId);
  if (housemate) {
    selectedHousemate = housemate;
    showHousemateDetail = true;
    renderHousemateDetail();
  }
}

function closeHousemateDetail() {
  showHousemateDetail = false;
  selectedHousemate = null;
  renderMainApp();
}

function renderHousemateDetail() {
  if (!selectedHousemate) return;
  
  const h = selectedHousemate;
  const avatar = h.avatarUrl || getHousemateAvatar(h.sex);
  const isAvatarImage = h.avatarUrl && h.avatarUrl.startsWith('http');
  const statusLabel = h.status === 'in-game' ? '🏠 In Game' : '🚪 Evicted';
  const statusColor = h.status === 'in-game' ? '#4CAF50' : '#e94560';
  
  root.innerHTML = `
    <div class="housemate-detail-screen" style="min-height:100vh;background:#0f0e17;">
      <div class="housemate-detail-header" style="display:flex;justify-content:space-between;align-items:center;padding:0.8rem 1rem;background:#1a1a2e;border-bottom:1px solid #2a2a4e;position:sticky;top:0;z-index:100;">
        <button class="back-btn" onclick="closeHousemateDetail()" style="background:none;border:none;color:#fffffe;font-size:1.5rem;cursor:pointer;">←</button>
        <span style="color:#fffffe;font-weight:600;">Housemate Profile</span>
        <div style="width:40px;"></div>
      </div>
      <div class="housemate-detail-body" style="padding:1.5rem;max-width:500px;margin:0 auto;">
        <div style="background:#1a1a2e;border-radius:16px;padding:1.5rem;border:1px solid #2a2a4e;">
          <div style="text-align:center;margin-bottom:1rem;">
            <div style="width:120px;height:120px;border-radius:50%;background:#2a2a4e;display:flex;align-items:center;justify-content:center;font-size:4rem;margin:0 auto;overflow:hidden;border:3px solid ${statusColor};">
              ${isAvatarImage ? `<img src="${avatar}" style="width:100%;height:100%;object-fit:cover;">` : avatar}
            </div>
            <div style="margin-top:0.5rem;display:inline-block;padding:0.2rem 1rem;border-radius:12px;background:${statusColor}30;color:${statusColor};font-size:0.8rem;font-weight:600;">${statusLabel}</div>
          </div>
          
          <h2 style="color:#fffffe;font-size:1.5rem;text-align:center;margin-bottom:0.5rem;">${escapeHtml(h.name)}</h2>
          
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.5rem;margin-bottom:1rem;">
            <div style="background:#0f0e17;border-radius:10px;padding:0.8rem;text-align:center;">
              <div style="color:#6b7280;font-size:0.7rem;">Sex</div>
              <div style="color:#fffffe;font-size:1.1rem;">${h.sex === 'female' ? '♀ Female' : '♂ Male'}</div>
            </div>
            <div style="background:#0f0e17;border-radius:10px;padding:0.8rem;text-align:center;">
              <div style="color:#6b7280;font-size:0.7rem;">Age</div>
              <div style="color:#fffffe;font-size:1.1rem;">${h.age || 'N/A'}</div>
            </div>
            <div style="background:#0f0e17;border-radius:10px;padding:0.8rem;text-align:center;">
              <div style="color:#6b7280;font-size:0.7rem;">State</div>
              <div style="color:#fffffe;font-size:1.1rem;">${escapeHtml(h.state || 'N/A')}</div>
            </div>
            <div style="background:#0f0e17;border-radius:10px;padding:0.8rem;text-align:center;">
              <div style="color:#6b7280;font-size:0.7rem;">Occupation</div>
              <div style="color:#fffffe;font-size:1.1rem;">${escapeHtml(h.occupation || 'N/A')}</div>
            </div>
          </div>
          
          ${h.biography ? `
            <div style="background:#0f0e17;border-radius:10px;padding:1rem;">
              <div style="color:#6b7280;font-size:0.7rem;margin-bottom:0.3rem;">📖 Biography</div>
              <div style="color:#e5e7eb;font-size:0.95rem;line-height:1.6;white-space:pre-wrap;">${escapeHtml(h.biography)}</div>
            </div>
          ` : ''}
        </div>
      </div>
    </div>
  `;
}

// ============================================================
// ===== ADS SCREEN =====
// ============================================================

function openAdsScreen() {
  showAdsScreen = true;
  renderAdsScreen();
}

function closeAdsScreen() {
  showAdsScreen = false;
  renderMainApp();
}

function renderAdsScreen() {
  showAdsScreen = true;
  
  let adsListHTML = '';
  if (userAds.length === 0) {
    adsListHTML = `
      <div style="text-align:center;padding:2rem;color:#6b7280;">
        <p style="font-size:2rem;margin-bottom:0.5rem;">📢</p>
        <p>No ads yet. Create your first ad!</p>
      </div>
    `;
  } else {
    adsListHTML = userAds.map(ad => {
      const statusLabel = ad.status === 'approved' ? '✅ Approved' : 
                          ad.status === 'pending_payment' ? '⏳ Payment Pending' : 
                          ad.status === 'pending' ? '⏳ Pending Approval' : 
                          ad.status === 'rejected' ? '❌ Rejected' : '⏳ Pending';
      const statusColor = ad.status === 'approved' ? '#4CAF50' : 
                          ad.status === 'pending_payment' ? '#FF9800' : 
                          ad.status === 'pending' ? '#FF9800' :
                          ad.status === 'rejected' ? '#e94560' : '#FF9800';
      const budgetLeft = ad.budgetLeft || 0;
      const totalImpressions = ad.totalImpressions || 0;
      const amount = ad.amount || 0;
      
      return `
        <div onclick="openAdDetail('${ad.id}')" style="background:#1a1a2e;border-radius:12px;padding:0.8rem 1rem;margin-bottom:0.5rem;border:1px solid #2a2a4e;cursor:pointer;display:flex;align-items:center;gap:0.8rem;transition:all 0.2s;">
          <div style="font-size:1.5rem;">📢</div>
          <div style="flex:1;">
            <div style="color:#fffffe;font-weight:600;">${escapeHtml(ad.businessName)}</div>
            <div style="font-size:0.8rem;color:${statusColor};">${statusLabel}</div>
            <div style="font-size:0.7rem;color:#6b7280;">💰 ₦${budgetLeft.toLocaleString()} left · 👁️ ${totalImpressions.toLocaleString()} impressions</div>
            ${ad.uniqueCode ? `<div style="font-size:0.6rem;color:#6b7280;font-family:monospace;">🔑 ${ad.uniqueCode}</div>` : ''}
          </div>
          <div style="color:#6b7280;font-size:1.2rem;">›</div>
        </div>
      `;
    }).join('');
  }
  
  root.innerHTML = `
    <div class="ads-screen" style="min-height:100vh;background:#0f0e17;">
      <div class="ads-screen-header" style="display:flex;justify-content:space-between;align-items:center;padding:0.8rem 1rem;background:#1a1a2e;border-bottom:1px solid #2a2a4e;position:sticky;top:0;z-index:100;">
        <button class="back-btn" onclick="closeAdsScreen()" style="background:none;border:none;color:#fffffe;font-size:1.5rem;cursor:pointer;">←</button>
        <span style="color:#fffffe;font-weight:600;">📢 My Ads</span>
        <button onclick="openCreateAdModal()" style="background:#e94560;border:none;color:white;padding:0.3rem 0.8rem;border-radius:12px;font-size:1.2rem;cursor:pointer;">➕</button>
      </div>
      <div class="ads-screen-body" style="padding:1rem;max-width:500px;margin:0 auto;">
        ${adsListHTML}
        <button onclick="openCreateAdModal()" style="width:100%;padding:0.8rem;background:#1a1a2e;border:1px solid #2a2a4e;border-radius:12px;color:#fffffe;font-weight:600;cursor:pointer;margin-top:0.5rem;">
          ➕ Create New Ad
        </button>
      </div>
    </div>
  `;
}

// ============================================================
// ===== AD DETAIL SCREEN =====
// ============================================================

function openAdDetail(adId) {
  const ad = userAds.find(a => a.id === adId);
  if (!ad) {
    showToast('Ad not found.', false);
    return;
  }
  selectedAdDetail = ad;
  showAdDetail = true;
  renderAdDetail();
}

function closeAdDetail() {
  showAdDetail = false;
  selectedAdDetail = null;
  renderAdsScreen();
}

function renderAdDetail() {
  if (!selectedAdDetail) return;
  
  const ad = selectedAdDetail;
  const statusLabel = ad.status === 'approved' ? '✅ Approved' : 
                      ad.status === 'pending_payment' ? '⏳ Payment Pending' : 
                      ad.status === 'pending' ? '⏳ Pending Approval' : 
                      ad.status === 'rejected' ? '❌ Rejected' : '⏳ Pending';
  const statusColor = ad.status === 'approved' ? '#4CAF50' : 
                      ad.status === 'pending_payment' ? '#FF9800' : 
                      ad.status === 'pending' ? '#FF9800' :
                      ad.status === 'rejected' ? '#e94560' : '#FF9800';
  const budgetLeft = ad.budgetLeft || 0;
  const totalImpressions = ad.totalImpressions || 0;
  const amount = ad.amount || 0;
  
  const dailyImps = ad.dailyImpressions || {};
  const dates = Object.keys(dailyImps).sort().slice(-7);
  const maxVal = Math.max(...Object.values(dailyImps), 1);
  
  let chartHTML = '';
  if (dates.length === 0) {
    chartHTML = '<div style="color:#6b7280;font-size:0.8rem;text-align:center;padding:0.5rem;">No data yet</div>';
  } else {
    chartHTML = `<div style="display:flex;align-items:flex-end;gap:0.5rem;height:60px;padding-top:0.5rem;">`;
    for (const date of dates) {
      const val = dailyImps[date] || 0;
      const height = (val / maxVal) * 50 + 10;
      const shortDate = date.substring(5);
      chartHTML += `
        <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:0.2rem;">
          <div style="width:100%;background:#e94560;border-radius:4px;min-height:4px;height:${height}px;transition:height 0.3s;"></div>
          <span style="font-size:0.6rem;color:#6b7280;">${shortDate}</span>
        </div>
      `;
    }
    chartHTML += `</div>`;
  }
  
  let paymentInfoHTML = '';
  if (ad.status === 'pending_payment') {
    paymentInfoHTML = `
      <div style="background:#0f0e17;border-radius:12px;padding:1rem;border:1px solid #e94560;margin-bottom:1rem;">
        <div style="color:#FFB300;font-weight:600;text-align:center;margin-bottom:0.5rem;">⏳ Payment Pending</div>
        <div style="color:#a7a9be;font-size:0.85rem;text-align:center;margin-bottom:0.5rem;">
          Send <strong>₦${amount.toLocaleString()}</strong> to:
        </div>
        <div style="text-align:center;">
          <div style="color:#fffffe;font-size:1.1rem;font-weight:600;">${OPAY_ACCOUNT}</div>
          <div style="color:#FFB300;font-size:0.9rem;">${OPAY_ACCOUNT_NAME}</div>
          <div style="color:#6b7280;font-size:0.8rem;">${OPAY_BANK}</div>
        </div>
        <div style="display:flex;align-items:center;justify-content:center;gap:0.5rem;margin-top:0.5rem;">
          <span style="color:#a7a9be;font-size:0.8rem;">📋 Code:</span>
          <code style="color:#FFB300;font-size:0.9rem;font-weight:bold;background:#0f0e17;padding:0.2rem 0.6rem;border-radius:4px;border:1px solid #2a2a4e;">${ad.uniqueCode || 'N/A'}</code>
          <button onclick="copyUniqueCode('${ad.uniqueCode || ''}')" style="background:#e94560;border:none;color:white;padding:0.2rem 0.6rem;border-radius:4px;cursor:pointer;font-size:0.7rem;">📋 Copy</button>
        </div>
        <div style="color:#6b7280;font-size:0.7rem;text-align:center;margin-top:0.3rem;">Paste code in remark/message field when sending</div>
      </div>
    `;
  }
  
  root.innerHTML = `
    <div class="ad-detail-screen" style="min-height:100vh;background:#0f0e17;">
      <div class="ad-detail-header" style="display:flex;justify-content:space-between;align-items:center;padding:0.8rem 1rem;background:#1a1a2e;border-bottom:1px solid #2a2a4e;position:sticky;top:0;z-index:100;">
        <button class="back-btn" onclick="closeAdDetail()" style="background:none;border:none;color:#fffffe;font-size:1.5rem;cursor:pointer;">←</button>
        <span style="color:#fffffe;font-weight:600;">Ad Details</span>
        <div style="width:40px;"></div>
      </div>
      <div class="ad-detail-body" style="padding:1.5rem;max-width:500px;margin:0 auto;">
        <div style="background:#1a1a2e;border-radius:16px;padding:1.5rem;border:1px solid #2a2a4e;">
          ${ad.imageUrl ? `
            <div style="border-radius:12px;overflow:hidden;margin-bottom:1rem;background:#0f0e17;">
              <img src="${ad.imageUrl}" alt="${ad.businessName}" style="width:100%;max-height:200px;object-fit:contain;display:block;">
            </div>
          ` : ''}
          
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem;">
            <h2 style="color:#fffffe;font-size:1.3rem;">${escapeHtml(ad.businessName)}</h2>
            <span style="padding:0.2rem 0.8rem;border-radius:12px;background:${statusColor}30;color:${statusColor};font-size:0.7rem;font-weight:600;">${statusLabel}</span>
          </div>
          
          ${paymentInfoHTML}
          
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:0.5rem;margin:1rem 0;">
            <div style="background:#0f0e17;border-radius:10px;padding:0.8rem;text-align:center;">
              <div style="color:#FFB300;font-size:1.2rem;font-weight:bold;">₦${amount.toLocaleString()}</div>
              <div style="color:#6b7280;font-size:0.6rem;">Total Budget</div>
            </div>
            <div style="background:#0f0e17;border-radius:10px;padding:0.8rem;text-align:center;">
              <div style="color:#FFB300;font-size:1.2rem;font-weight:bold;">₦${budgetLeft.toLocaleString()}</div>
              <div style="color:#6b7280;font-size:0.6rem;">Budget Left</div>
            </div>
            <div style="background:#0f0e17;border-radius:10px;padding:0.8rem;text-align:center;">
              <div style="color:#FFB300;font-size:1.2rem;font-weight:bold;">${totalImpressions.toLocaleString()}</div>
              <div style="color:#6b7280;font-size:0.6rem;">Total Impressions</div>
            </div>
          </div>
          
          <div style="background:#0f0e17;border-radius:10px;padding:0.8rem;">
            <div style="color:#6b7280;font-size:0.7rem;margin-bottom:0.3rem;">📊 Daily Impressions</div>
            ${chartHTML}
          </div>
          
          ${ad.uniqueCode ? `
            <div style="margin-top:1rem;background:#0f0e17;border-radius:10px;padding:0.8rem;text-align:center;">
              <div style="color:#6b7280;font-size:0.7rem;">Unique Code</div>
              <div style="color:#FFB300;font-family:monospace;font-size:1.1rem;letter-spacing:2px;">${ad.uniqueCode}</div>
              <button onclick="copyUniqueCode('${ad.uniqueCode}')" style="margin-top:0.3rem;background:#2a2a4e;border:none;color:#a7a9be;padding:0.2rem 0.8rem;border-radius:6px;cursor:pointer;font-size:0.7rem;">📋 Copy</button>
            </div>
          ` : ''}
        </div>
      </div>
    </div>
  `;
}

// ============================================================
// ===== CREATE AD MODAL =====
// ============================================================

function openCreateAdModal() {
  selectedAdImageFile = null;
  const modal = document.getElementById('createAdModal');
  if (modal) {
    modal.style.display = 'flex';
    const nameInput = document.getElementById('adBusinessNameInput');
    const budgetInput = document.getElementById('adBudgetInput');
    if (nameInput) nameInput.value = '';
    if (budgetInput) budgetInput.value = '';
    const previewContainer = document.getElementById('adImagePreviewContainer');
    if (previewContainer) previewContainer.innerHTML = '';
    const imageInput = document.getElementById('adImageInput');
    if (imageInput) imageInput.value = '';
    updateAdImpressionCount();
  } else {
    showToast('Modal not found. Please refresh.', false);
  }
}

function closeCreateAdModal() {
  const modal = document.getElementById('createAdModal');
  if (modal) {
    modal.style.display = 'none';
  }
}

function previewAdImage(event) {
  const file = event.target.files[0];
  if (file) {
    selectedAdImageFile = file;
    const reader = new FileReader();
    reader.onload = function(e) {
      const container = document.getElementById('adImagePreviewContainer');
      if (container) {
        container.innerHTML = `
          <div style="position:relative;display:inline-block;">
            <img src="${e.target.result}" style="max-width:100%;max-height:150px;border-radius:8px;margin-top:0.5rem;border:1px solid #2a2a4e;">
            <button onclick="removeAdImage()" style="position:absolute;top:-8px;right:-8px;background:#e94560;border:none;border-radius:50%;width:24px;height:24px;color:white;font-size:12px;cursor:pointer;">✕</button>
          </div>
        `;
      }
    };
    reader.readAsDataURL(file);
  }
}

function removeAdImage() {
  selectedAdImageFile = null;
  const container = document.getElementById('adImagePreviewContainer');
  if (container) {
    container.innerHTML = '';
  }
  const imageInput = document.getElementById('adImageInput');
  if (imageInput) {
    imageInput.value = '';
  }
}

function updateAdImpressionCount() {
  const budgetInput = document.getElementById('adBudgetInput');
  const budget = parseFloat(budgetInput ? budgetInput.value : 0) || 0;
  const impressions = Math.floor(budget / COST_PER_IMPRESSION);
  const display = document.getElementById('adImpressionDisplay');
  if (display) {
    display.textContent = impressions.toLocaleString();
  }
}

async function submitAdRequest() {
  const nameInput = document.getElementById('adBusinessNameInput');
  const budgetInput = document.getElementById('adBudgetInput');
  
  const businessName = nameInput ? nameInput.value.trim() : '';
  const budget = parseFloat(budgetInput ? budgetInput.value : 0);
  
  if (!businessName) {
    showToast('Please enter a business name.', false);
    return;
  }
  if (!budget || budget < 100) {
    showToast('Minimum budget is ₦100.', false);
    return;
  }
  if (!selectedAdImageFile) {
    showToast('Please upload a banner image.', false);
    return;
  }
  
  const btn = document.getElementById('submitAdBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ Uploading...';
  }
  
  let imageUrl = null;
  
  try {
    if (selectedAdImageFile.size > MAX_UPLOAD_SIZE) {
      showToast('Image is larger than 3MB. Please select a smaller image.', false);
      if (btn) {
        btn.disabled = false;
        btn.textContent = '💰 Submit Ad';
      }
      return;
    }
    
    imageUrl = await uploadAdImage(selectedAdImageFile);
    
    if (!imageUrl) {
      throw new Error('Image upload failed');
    }
    
    btn.textContent = '⏳ Creating ad...';
    const uniqueCode = await createAdRequest({
      businessName: businessName,
      budget: budget,
      imageUrl: imageUrl,
      targetLocation: false,
      country: '',
      state: ''
    });
    
    if (uniqueCode) {
      closeCreateAdModal();
      showPaymentModal(uniqueCode, businessName, budget);
      if (showAdsScreen) {
        renderAdsScreen();
      }
    } else {
      if (imageUrl) {
        await deleteR2Images([imageUrl]);
      }
      throw new Error('Failed to create ad request');
    }
  } catch (error) {
    console.error('Error submitting ad:', error);
    
    if (imageUrl) {
      await deleteR2Images([imageUrl]);
    }
    
    showToast('❌ Failed to submit ad: ' + error.message, false);
  }
  
  if (btn) {
    btn.disabled = false;
    btn.textContent = '💰 Submit Ad';
  }
}

// ============================================================
// ===== ADMIN FUNCTIONS FOR WORD GAME =====
// ============================================================

async function addDailyWord(word, hint, sponsorImage, colors, date) {
  if (!word || !hint || !date) {
    alert('Please fill in word, hint, and date');
    return false;
  }
  try {
    await db.collection('daily_words').add({
      word: word.trim(),
      hint: hint.trim(),
      sponsorImage: sponsorImage || '',
      colors: colors || {
        heading: '#e94560',
        answer: '#FFB300',
        underscore: '#fffffe',
        hint: '#a7a9be',
        keyboard: '#2a2a4e',
        score: '#e94560'
      },
      date: date,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    showToast('✅ Word game added!', true);
    return true;
  } catch (error) {
    console.error('Error adding daily word:', error);
    alert('Failed to add word game.');
    return false;
  }
}

async function deleteWordGame(wordId) {
  if (!confirm('Are you sure you want to delete this word game? This cannot be undone!')) {
    return false;
  }
  try {
    await db.collection('daily_words').doc(wordId).delete();
    const submissionsSnapshot = await db.collection('word_submissions')
      .where('wordId', '==', wordId)
      .get();
    const batch = db.batch();
    submissionsSnapshot.forEach(doc => {
      batch.delete(doc.ref);
    });
    await batch.commit();
    showToast('✅ Word game deleted successfully!', true);
    return true;
  } catch (error) {
    console.error('Error deleting word game:', error);
    showToast('❌ Failed to delete word game.', false);
    return false;
  }
}

async function loadWordSubmissionsForAdmin(wordId) {
  try {
    const snapshot = await db.collection('word_submissions')
      .where('wordId', '==', wordId)
      .get();
    const submissions = [];
    snapshot.forEach((doc) => {
      submissions.push({ id: doc.id, ...doc.data() });
    });
    return submissions;
  } catch (error) {
    console.error('Error loading submissions:', error);
    return [];
  }
}

async function submitWordAnswer(wordId, answer) {
  if (!currentUser) {
    showToast('Please sign in to play', false);
    return false;
  }
  if (!wordId || !answer) return false;
  
  try {
    const existing = await db.collection('word_submissions')
      .where('wordId', '==', wordId)
      .where('userId', '==', currentUser.uid)
      .get();
    if (!existing.empty) {
      showToast('You already submitted this word!', false);
      return false;
    }
    
    const wordDoc = await db.collection('daily_words').doc(wordId).get();
    if (!wordDoc.exists) {
      showToast('Word not found', false);
      return false;
    }
    const wordData = wordDoc.data();
    if (answer.trim().toLowerCase() !== wordData.word.toLowerCase()) {
      showToast('❌ Incorrect word! Try again.', false);
      return false;
    }
    
    await db.collection('word_submissions').add({
      wordId: wordId,
      userId: currentUser.uid,
      username: currentUser.displayName || currentUser.email,
      email: currentUser.email,
      submittedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    
    await awardPointsForInteraction(currentUser.uid, wordId, 'word game correct');
    currentUserPoints = (currentUserPoints || 0) + 10;
    showToast('✅ Correct! +10 points!', true);
    return true;
  } catch (error) {
    console.error('Error submitting word answer:', error);
    showToast('Error submitting answer', false);
    return false;
  }
}

// ============================================================
// ===== ADMIN FUNCTIONS FOR FEED POSTS =====
// ============================================================

async function createFeedPost(postData) {
  try {
    await db.collection('feed_posts').add({
      type: postData.type || 'text',
      message: postData.content || '',
      content: postData.content || '',
      imageUrls: postData.imageUrls || [],
      pollOptions: postData.pollOptions || [],
      pollVotes: {},
      likes: 0,
      commentCount: 0,
      reactions: {},
      liked: false,
      user: 'DHouse Admin',
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      emojiReactions: {}
    });
    dataManager.invalidateCache('feed_posts');
    showToast('✅ Feed post created!', true);
    return true;
  } catch (error) {
    console.error('Error creating feed post:', error);
    alert('Failed to create feed post.');
    return false;
  }
}

// ============================================================
// ===== ADMIN PREDICTION FUNCTIONS =====
// ============================================================

async function createPrediction(predictionData) {
  try {
    await db.collection('predictions').add({
      text: predictionData.text,
      options: predictionData.options,
      correctAnswer: null,
      endsAt: predictionData.endsAt,
      pointsValue: predictionData.pointsValue || 100,
      isActive: true,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    dataManager.invalidateCache('predictions');
    showToast('✅ Prediction created!', true);
    return true;
  } catch (error) {
    console.error('Error creating prediction:', error);
    showToast('❌ Failed to create prediction.', false);
    return false;
  }
}

async function setCorrectAnswer(predictionId, correctAnswer) {
  if (!predictionId || !correctAnswer) {
    showToast('Invalid prediction or answer.', false);
    return false;
  }
  
  try {
    console.log('🔍 Setting correct answer for prediction:', predictionId);
    console.log('✅ Correct answer:', correctAnswer);
    
    const predRef = db.collection('predictions').doc(predictionId);
    const predDoc = await predRef.get();
    
    if (!predDoc.exists) {
      console.error('❌ Prediction document does not exist:', predictionId);
      showToast('Prediction not found. It may have been deleted.', false);
      return false;
    }
    
    const predData = predDoc.data();
    console.log('📊 Prediction data:', predData);
    
    const pointsValue = predData.pointsValue || 100;
    
    await predRef.update({
      correctAnswer: correctAnswer,
      isActive: false,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    
    console.log('✅ Prediction updated with correct answer');
    
    try {
      const userPredsSnapshot = await db.collection('user_predictions')
        .where('predictionId', '==', predictionId)
        .get();
      
      console.log(`👥 Found ${userPredsSnapshot.size} user predictions`);
      
      if (userPredsSnapshot.empty) {
        showToast(`✅ Correct answer set to "${correctAnswer}"! No users voted on this prediction.`, true);
        dataManager.invalidateCache('predictions');
        return true;
      }
      
      const batch = db.batch();
      let correctCount = 0;
      
      for (const doc of userPredsSnapshot.docs) {
        const data = doc.data();
        const userId = data.userId;
        const isCorrect = data.selectedOption === correctAnswer;
        
        batch.update(doc.ref, { 
          isCorrect: isCorrect,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        
        if (isCorrect && userId) {
          correctCount++;
          try {
            const userRef = db.collection('users').doc(userId);
            const userDoc = await userRef.get();
            
            if (userDoc.exists()) {
              const userData = userDoc.data();
              const currentPoints = userData.totalPoints || 0;
              
              batch.update(userRef, {
                totalPoints: currentPoints + pointsValue,
                correctPredictions: (userData.correctPredictions || 0) + 1
              });
              
              console.log(`⭐ Awarded ${pointsValue} points to user ${userId}`);
            }
          } catch (userError) {
            console.error(`❌ Error updating user ${userId}:`, userError);
          }
        }
      }
      
      await batch.commit();
      console.log(`✅ Batch committed: ${correctCount} users got it right!`);
      showToast(`✅ Correct answer set to "${correctAnswer}"! ${correctCount} users got it right! (+${pointsValue} pts each)`, true);
      
      // Invalidate caches
      dataManager.invalidateCache('predictions');
      dataManager.invalidateCache(`user_predictions_${currentUser?.uid}`);
      
    } catch (permissionError) {
      console.log('⚠️ Could not read user_predictions (permission denied), but prediction was updated');
      showToast(`✅ Correct answer set to "${correctAnswer}"! (Points will be awarded when users check back)`, true);
    }
    
    return true;
    
  } catch (error) {
    console.error('❌ Error setting correct answer:', error);
    showToast('❌ Failed to set correct answer: ' + error.message, false);
    return false;
  }
}

// ============================================================
// ===== SUBMIT ADMIN PREDICTION =====
// ============================================================
async function submitAdminPrediction() {
  const text = document.getElementById('adminPredText');
  const optionsInput = document.getElementById('adminPredOptions');
  const endsAt = document.getElementById('adminPredEndsAt');
  const points = document.getElementById('adminPredPoints');
  
  if (!text || !text.value.trim()) {
    alert('Please enter a question.');
    return;
  }
  if (!optionsInput || !optionsInput.value.trim()) {
    alert('Please enter options.');
    return;
  }
  if (!endsAt || !endsAt.value) {
    alert('Please select an end time.');
    return;
  }
  
  const options = optionsInput.value.split(',').map(o => o.trim()).filter(o => o);
  if (options.length < 2) {
    alert('Please enter at least 2 options.');
    return;
  }
  
  const predictionData = {
    text: text.value.trim(),
    options: options,
    endsAt: new Date(endsAt.value),
    pointsValue: parseInt(points.value) || 100
  };
  
  const success = await createPrediction(predictionData);
  if (success) {
    text.value = '';
    optionsInput.value = '';
    endsAt.value = '';
    renderAdminApp();
  }
}

// ============================================================
// ===== SET ADMIN CORRECT ANSWER =====
// ============================================================
async function setAdminCorrectAnswer(predictionId) {
  const select = document.getElementById(`setCorrect_${predictionId}`);
  if (!select) {
    showToast('Selection element not found.', false);
    return;
  }
  
  const correctAnswer = select.value;
  if (!correctAnswer) {
    showToast('Please select a correct answer from the dropdown.', false);
    return;
  }
  
  const btn = select.nextElementSibling;
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ Processing...';
  }
  
  try {
    const success = await setCorrectAnswer(predictionId, correctAnswer);
    if (success) {
      renderAdminApp();
    }
  } catch (error) {
    console.error('Error in setAdminCorrectAnswer:', error);
    showToast('Failed to set correct answer. Please try again.', false);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Set';
    }
  }
}

// ============================================================
// ===== VIEW PREDICTION USERS =====
// ============================================================

async function viewPredictionUsers(predictionId) {
  const modal = document.getElementById('predictionUsersModal');
  const list = document.getElementById('predictionUsersList');
  
  if (!modal || !list) {
    showToast('Modal not found. Please refresh.', false);
    return;
  }
  
  modal.style.display = 'flex';
  list.innerHTML = '<div style="text-align:center;padding:1rem;color:#6b7280;">Loading users...</div>';
  
  try {
    const snapshot = await db.collection('user_predictions')
      .where('predictionId', '==', predictionId)
      .where('isCorrect', '==', true)
      .get();
    
    if (snapshot.empty) {
      list.innerHTML = '<div style="text-align:center;padding:1rem;color:#6b7280;">No users got this prediction correct yet.</div>';
      return;
    }
    
    const userIds = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      if (data.userId) {
        userIds.push(data.userId);
      }
    });
    
    if (userIds.length === 0) {
      list.innerHTML = '<div style="text-align:center;padding:1rem;color:#6b7280;">No user IDs found.</div>';
      return;
    }
    
    let usersHtml = `
      <div style="display:grid;grid-template-columns:2fr 2fr 1fr;gap:0.5rem;padding:0.5rem;background:#0f0e17;border-radius:8px;color:#a7a9be;font-size:0.7rem;font-weight:600;margin-bottom:0.5rem;">
        <span>Username</span>
        <span>Email</span>
        <span>UID</span>
      </div>
    `;
    
    let foundCount = 0;
    for (const uid of userIds) {
      try {
        const userDoc = await db.collection('users').doc(uid).get();
        if (userDoc.exists) {
          const userData = userDoc.data();
          const username = userData.username || userData.displayName || 'Unknown';
          const email = userData.email || 'No email';
          foundCount++;
          
          usersHtml += `
            <div style="display:grid;grid-template-columns:2fr 2fr 1fr;gap:0.5rem;padding:0.4rem 0.5rem;background:#0f0e17;border-radius:6px;margin-bottom:0.2rem;font-size:0.8rem;color:#e5e7eb;cursor:pointer;transition:background 0.2s;" 
                 onclick="copyToClipboard('${uid}')" 
                 onmouseover="this.style.background='#2a2a4e'" 
                 onmouseout="this.style.background='#0f0e17'"
                 title="Click to copy UID">
              <span>${escapeHtml(username)}</span>
              <span style="font-size:0.75rem;">${escapeHtml(email)}</span>
              <span style="color:#6b7280;font-family:monospace;font-size:0.7rem;">${uid.substring(0, 12)}...</span>
            </div>
          `;
        }
      } catch (error) {
        console.error('Error fetching user:', uid, error);
      }
    }
    
    if (foundCount === 0) {
      list.innerHTML = '<div style="text-align:center;padding:1rem;color:#6b7280;">Could not find user details for any users.</div>';
    } else {
      usersHtml += `
        <div style="margin-top:0.5rem;padding:0.5rem;text-align:center;color:#6b7280;font-size:0.7rem;">
          ${foundCount} user${foundCount !== 1 ? 's' : ''} found • Click any row to copy UID
        </div>
      `;
      list.innerHTML = usersHtml;
    }
    
  } catch (error) {
    console.error('Error loading prediction users:', error);
    list.innerHTML = `<div style="text-align:center;padding:1rem;color:#e94560;">Error loading users: ${error.message}</div>`;
  }
}

function closePredictionUsersModal() {
  const modal = document.getElementById('predictionUsersModal');
  if (modal) {
    modal.style.display = 'none';
  }
}

document.addEventListener('click', function(e) {
  const modal = document.getElementById('predictionUsersModal');
  if (modal && e.target === modal) {
    closePredictionUsersModal();
  }
});

// ============================================================
// ===== RENDER FUNCTIONS =====
// ============================================================

function renderLanding() {
  return `
    <div class="landing">
      <div class="landing-card">
        <span class="landing-emoji">🏠</span>
        <h1>DHouse</h1>
        <p class="landing-tagline">Reality TV Companion App</p>
        
        <div class="platform-tabs">
          <button class="tab-btn active" onclick="switchPlatform('android')">🤖 Android</button>
          <button class="tab-btn" onclick="switchPlatform('ios')">🍎 iOS</button>
        </div>
        
        <div id="instructions" class="instruction-card">
          <ol>
            <li>Tap the <strong>⋮</strong> menu (3 dots)</li>
            <li>Select <strong>"Add to Home screen"</strong></li>
            <li>Tap <strong>"Install"</strong></li>
            <li>Launch from your home screen</li>
          </ol>
        </div>
        
        <button class="continue-btn" onclick="checkInstall()">✅ I've installed it!</button>
        <p class="landing-footer">⚡ No app store needed • Works offline • Free</p>
      </div>
    </div>
  `;
}

function switchPlatform(plat) {
  const tabs = document.querySelectorAll('.tab-btn');
  tabs.forEach(t => t.classList.remove('active'));
  if (plat === 'android') {
    tabs[0].classList.add('active');
    document.getElementById('instructions').innerHTML = `
      <ol>
        <li>Tap the <strong>⋮</strong> menu (3 dots)</li>
        <li>Select <strong>"Add to Home screen"</strong></li>
        <li>Tap <strong>"Install"</strong></li>
        <li>Launch from your home screen</li>
      </ol>
    `;
  } else {
    tabs[1].classList.add('active');
    document.getElementById('instructions').innerHTML = `
      <ol>
        <li>Tap the <strong>Share</strong> button <span style="font-size:1.2rem;">⎔</span></li>
        <li>Scroll down and tap <strong>"Add to Home Screen"</strong></li>
        <li>Tap <strong>"Add"</strong> in the top right</li>
        <li>Launch from your home screen</li>
      </ol>
    `;
  }
}

function checkInstall() {
  if (window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone) {
    showAuth('login');
  } else {
    alert('📱 After installing, reopen the app from your home screen!');
  }
}

function showAuth(screen) {
  currentScreen = screen;
  renderAuth();
}

function renderAuth() {
  const isAdminLogin = currentScreen === 'admin-login';
  
  if (currentScreen === 'login' || currentScreen === 'admin-login') {
    const title = isAdminLogin ? 'Admin Access' : 'DHouse';
    const subtitle = isAdminLogin ? 'Admin Dashboard Login' : 'Welcome back!';
    const logo = isAdminLogin ? '👑' : '🏠';
    const onSubmit = isAdminLogin ? 'handleAdminLogin(event)' : 'handleLogin(event)';
    
    root.innerHTML = `
      <div class="auth-container">
        <div class="auth-card">
          <span class="auth-logo">${logo}</span>
          <h1>${title}</h1>
          <p class="auth-subtitle">${subtitle}</p>
          <form id="loginForm" onsubmit="${onSubmit}">
            <input type="email" id="loginEmail" placeholder="Email" required>
            <input type="password" id="loginPassword" placeholder="Password" required>
            <button type="submit" class="auth-btn">${isAdminLogin ? 'Admin Login' : 'Login'}</button>
          </form>
          <div class="auth-links">
            ${!isAdminLogin ? `
              <button onclick="showAuth('signup')">Don't have an account? Sign Up</button>
              <button onclick="showAuth('reset')">Forgot Password?</button>
              <button onclick="showAuth('admin-login')" style="color:#e94560;">👑 Admin Login</button>
            ` : `
              <button onclick="showAuth('login')">← Back to User Login</button>
            `}
          </div>
        </div>
      </div>
    `;
  } else if (currentScreen === 'signup') {
    root.innerHTML = `
      <div class="auth-container">
        <div class="auth-card">
          <span class="auth-logo">🏠</span>
          <h1>DHouse</h1>
          <p class="auth-subtitle">Create your account</p>
          <form id="signupForm" onsubmit="handleSignup(event)">
            <div style="text-align:center;margin-bottom:1rem;">
              <div id="profilePreview" style="width:80px;height:80px;border-radius:50%;background:#e94560;color:white;display:inline-flex;align-items:center;justify-content:center;font-size:2rem;font-weight:bold;cursor:pointer;border:2px solid #2a2a4e;margin:0 auto;">
                📷
              </div>
              <input type="file" id="profilePicInput" accept="image/*" style="display:none;" onchange="previewProfilePic(event)">
              <button type="button" onclick="document.getElementById('profilePicInput').click()" style="display:block;margin:0.5rem auto;background:transparent;border:1px solid #2a2a4e;color:#a7a9be;padding:0.3rem 1rem;border-radius:12px;font-size:0.8rem;cursor:pointer;">Add Profile Picture</button>
            </div>
            <input type="text" id="signupUsername" placeholder="Username (lowercase, no spaces)" required oninput="validateUsername(this)" style="text-transform:lowercase;">
            <div style="color:#6b7280;font-size:0.7rem;margin-top:-0.3rem;margin-bottom:0.5rem;">Only letters, numbers, and underscores. All lowercase.</div>
            <input type="email" id="signupEmail" placeholder="Email" required>
            <input type="text" id="signupCountry" placeholder="Country" required>
            <input type="text" id="signupCity" placeholder="City" required>
            <input type="password" id="signupPassword" placeholder="Password (min 6 chars)" required minlength="6">
            <input type="password" id="signupConfirm" placeholder="Confirm Password" required>
            <button type="submit" class="auth-btn">Sign Up</button>
          </form>
          <div class="auth-links">
            <button onclick="showAuth('login')">Already have an account? Login</button>
          </div>
        </div>
      </div>
    `;
  } else if (currentScreen === 'reset') {
    root.innerHTML = `
      <div class="auth-container">
        <div class="auth-card">
          <span class="auth-logo">🔑</span>
          <h1>DHouse</h1>
          <p class="auth-subtitle">Reset Password</p>
          <form id="resetForm" onsubmit="handleReset(event)">
            <input type="email" id="resetEmail" placeholder="Email" required>
            <button type="submit" class="auth-btn">Send Reset Link</button>
          </form>
          <div class="auth-links">
            <button onclick="showAuth('login')">Back to Login</button>
          </div>
        </div>
      </div>
    `;
  }
}

function validateUsername(input) {
  input.value = input.value.toLowerCase();
  input.value = input.value.replace(/\s/g, '');
  input.value = input.value.replace(/[^a-z0-9_]/g, '');
}

function previewProfilePic(event) {
  const file = event.target.files[0];
  if (file) {
    const reader = new FileReader();
    reader.onload = function(e) {
      profilePicData = e.target.result;
      document.getElementById('profilePreview').innerHTML = `<img src="${profilePicData}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">`;
    };
    reader.readAsDataURL(file);
  }
}

async function handleLogin(e) {
  e.preventDefault();
  const email = document.getElementById('loginEmail').value;
  const password = document.getElementById('loginPassword').value;
  
  const config = await getAdminConfig();
  if (config && config.adminEmail === email) {
    alert('👑 Please use the Admin Login option.');
    return;
  }
  
  try {
    await auth.signInWithEmailAndPassword(email, password);
    logEvent('login', { method: 'email' });
  } catch (error) {
    alert('❌ ' + error.message);
  }
}

async function handleAdminLogin(e) {
  e.preventDefault();
  const email = document.getElementById('loginEmail').value;
  const password = document.getElementById('loginPassword').value;
  
  const config = await getAdminConfig();
  
  if (!config || config.adminEmail !== email) {
    alert('❌ Invalid admin credentials.');
    return;
  }
  
  try {
    await auth.signInWithEmailAndPassword(email, password);
  } catch (error) {
    alert('❌ ' + error.message);
  }
}

async function handleSignup(e) {
  e.preventDefault();
  const username = document.getElementById('signupUsername').value;
  const email = document.getElementById('signupEmail').value;
  const country = document.getElementById('signupCountry').value;
  const city = document.getElementById('signupCity').value;
  const password = document.getElementById('signupPassword').value;
  const confirm = document.getElementById('signupConfirm').value;
  
  if (!/^[a-z0-9_]{3,20}$/.test(username)) {
    alert('❌ Username must be 3-20 characters, lowercase letters, numbers, and underscores only.');
    return;
  }
  
  const config = await getAdminConfig();
  if (config && config.adminEmail === email) {
    alert('❌ This email is reserved for admin.');
    return;
  }
  
  if (password !== confirm) {
    alert('❌ Passwords do not match!');
    return;
  }
  if (password.length < 6) {
    alert('❌ Password must be at least 6 characters!');
    return;
  }
  
  try {
    const usersSnapshot = await db.collection('users')
      .where('usernameLower', '==', username.toLowerCase())
      .get();
    
    if (!usersSnapshot.empty) {
      alert('❌ Username "' + username + '" is already taken. Please choose another one.');
      return;
    }
  } catch (error) {
    console.error('Error checking username:', error);
    alert('❌ Error checking username availability. Please try again.');
    return;
  }
  
  try {
    const result = await auth.createUserWithEmailAndPassword(email, password);
    await result.user.updateProfile({ displayName: username });
    
    await db.collection('users').doc(result.user.uid).set({
      username: username,
      usernameLower: username.toLowerCase(),
      email: email,
      country: country,
      city: city,
      profilePic: profilePicData || null,
      totalPoints: 0,
      accuracy: 0,
      predictions: 0,
      correctPredictions: 0,
      createdAt: new Date()
    });
    
    logEvent('sign_up', {
      method: 'email',
      username: username,
      country: country
    });
    
    await result.user.sendEmailVerification();
    alert('📧 Verification email sent! Check inbox and spam.');
    await auth.signOut();
    profilePicData = null;
    showAuth('login');
  } catch (error) {
    alert('❌ ' + error.message);
  }
}

async function handleReset(e) {
  e.preventDefault();
  const email = document.getElementById('resetEmail').value;
  try {
    await auth.sendPasswordResetEmail(email);
    alert('📧 Password reset sent! Check inbox and spam.');
    showAuth('login');
  } catch (error) {
    alert('❌ ' + error.message);
  }
}

function getUserAvatar(name, profilePic) {
  if (profilePic) {
    return `<img src="${profilePic}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">`;
  }
  return name ? name[0].toUpperCase() : '👤';
}

function getUserAvatarSmall(name, profilePic) {
  if (profilePic) {
    return `<img src="${profilePic}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">`;
  }
  return name ? name[0].toUpperCase() : '👤';
}

// ============================================================
// ===== SEARCH FUNCTIONS =====
// ============================================================

function openSearchScreen() {
  showSearchScreen = true;
  renderMainApp();
  setTimeout(() => {
    const input = document.getElementById('searchInputFull');
    if (input) {
      input.focus();
    }
  }, 200);
}

function closeSearchScreen() {
  showSearchScreen = false;
  searchQuery = '';
  renderMainApp();
}

function handleSearch(e) {
  const query = e.target.value;
  searchQuery = query;
  
  if (searchTimeout) {
    clearTimeout(searchTimeout);
  }
  
  const resultsCount = document.getElementById('searchResultsCount');
  if (resultsCount) {
    if (query.length > 0) {
      resultsCount.textContent = 'Searching...';
    } else {
      resultsCount.textContent = '';
    }
  }
  
  searchTimeout = setTimeout(() => {
    if (query.trim()) {
      if (!recentSearches.includes(query)) {
        recentSearches.unshift(query);
        if (recentSearches.length > 5) recentSearches.pop();
      }
      performSearch(query);
    } else {
      renderMainApp();
    }
  }, 300);
}

async function performSearch(query) {
  if (isSearching) return;
  isSearching = true;
  
  try {
    const searchTerm = query.toLowerCase();
    const container = document.getElementById('pageContent');
    
    const filteredPosts = communityPosts.filter(p =>
      p.content?.toLowerCase().includes(searchTerm) ||
      p.user?.toLowerCase().includes(searchTerm) ||
      p.username?.toLowerCase().includes(searchTerm)
    );
    
    logEvent('search', {
      query: query,
      result_count: filteredPosts.length
    });
    
    const resultsCount = document.getElementById('searchResultsCount');
    if (resultsCount) {
      resultsCount.textContent = `Found ${filteredPosts.length} result${filteredPosts.length !== 1 ? 's' : ''}`;
    }
    
    renderSearchResults(filteredPosts);
    
  } catch (error) {
    console.error('Search error:', error);
    const resultsCount = document.getElementById('searchResultsCount');
    if (resultsCount) {
      resultsCount.textContent = 'Search error. Please try again.';
    }
  }
  
  isSearching = false;
}

function renderSearchResults(results) {
  const container = document.getElementById('pageContent');
  if (!container) return;
  
  if (results.length === 0 && searchQuery.trim()) {
    container.innerHTML = `
      <div class="search-screen" style="padding:1rem;">
        <div class="search-header" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;">
          <button onclick="closeSearchScreen()" style="background:none;border:none;color:#fffffe;font-size:1.5rem;cursor:pointer;">←</button>
          <span style="font-size:1.2rem;font-weight:600;color:#fffffe;">Search</span>
          <div style="width:40px;"></div>
        </div>
        <div class="search-bar-full" style="margin-bottom:1.5rem;">
          <input type="text" id="searchInputFull" placeholder="Search for posts, people..." value="${escapeHtml(searchQuery)}" oninput="handleSearch(event)" autofocus>
        </div>
        <div style="text-align:center;padding:3rem;color:#6b7280;">
          <p style="font-size:2rem;margin-bottom:0.5rem;">🔍</p>
          <p>No results found for "${escapeHtml(searchQuery)}"</p>
          <p style="font-size:0.8rem;margin-top:0.5rem;">Try different keywords</p>
        </div>
      </div>
    `;
    setTimeout(() => {
      const input = document.getElementById('searchInputFull');
      if (input) input.focus();
    }, 100);
    return;
  }
  
  let html = `
    <div class="search-screen" style="padding:1rem;">
      <div class="search-header" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;">
        <button onclick="closeSearchScreen()" style="background:none;border:none;color:#fffffe;font-size:1.5rem;cursor:pointer;">←</button>
        <span style="font-size:1.2rem;font-weight:600;color:#fffffe;">Search</span>
        <div style="width:40px;"></div>
      </div>
      <div class="search-bar-full" style="margin-bottom:1.5rem;">
        <input type="text" id="searchInputFull" placeholder="Search for posts, people..." value="${escapeHtml(searchQuery)}" oninput="handleSearch(event)" autofocus>
      </div>
      <div style="color:#a7a9be;font-weight:600;margin-bottom:0.8rem;">Results for "${escapeHtml(searchQuery)}" (${results.length})</div>
  `;
  
  results.forEach(post => {
    const time = post.time || 'Just now';
    const content = post.content || '';
    let displayContent = escapeHtml(content);
    if (searchQuery.trim()) {
      const regex = new RegExp(`(${escapeHtml(searchQuery)})`, 'gi');
      displayContent = displayContent.replace(regex, '<span style="background:#e94560;padding:0 4px;border-radius:4px;color:white;">$1</span>');
    }
    
    html += `
      <div class="search-result-item" onclick="closeSearchScreen();switchTab('community');" style="padding:0.8rem;background:#1a1a2e;border-radius:12px;margin-bottom:0.5rem;border:1px solid #2a2a4e;cursor:pointer;">
        <div style="display:flex;align-items:center;gap:0.8rem;">
          <div class="avatar" style="width:36px;height:36px;border-radius:50%;background:#e94560;display:flex;align-items:center;justify-content:center;font-weight:bold;font-size:0.9rem;color:white;flex-shrink:0;">${post.user?.[0]?.toUpperCase() || '?'}</div>
          <div style="flex:1;min-width:0;">
            <div style="color:#fffffe;font-weight:600;font-size:0.95rem;">${escapeHtml(post.user)}</div>
            <div style="color:#a7a9be;font-size:0.85rem;word-wrap:break-word;overflow-wrap:break-word;max-height:60px;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;">${displayContent}</div>
            <div style="color:#6b7280;font-size:0.75rem;margin-top:0.2rem;">❤️ ${post.likes || 0} · 💬 ${post.comments || 0} · ${time}</div>
          </div>
          <span style="color:#6b7280;font-size:1.2rem;">›</span>
        </div>
      </div>
    `;
  });
  
  html += `</div>`;
  container.innerHTML = html;
  
  setTimeout(() => {
    const input = document.getElementById('searchInputFull');
    if (input) input.focus();
  }, 100);
}

function renderSearchScreen() {
  return '';
}

// ============================================================
// ===== ADMIN APP =====
// ============================================================

function renderAdminApp() {
  if (showNotificationDetail && selectedNotification) {
    root.innerHTML = renderNotificationDetail();
    return;
  }
  
  if (showFullPostView && fullPostData) {
    renderFullPostView();
    return;
  }
  
  if (showReplyView && replyViewData) {
    renderReplyView();
    return;
  }
  
  const tabs = [
    { id: 'dashboard', label: '📊 Dashboard' },
    { id: 'users', label: '👥 Users' },
    { id: 'feed', label: '📰 Feed' },
    { id: 'wordgame', label: '🎯 Word Game' },
    { id: 'notifications', label: '📨 Notifications' },
    { id: 'broadcast', label: '📢 Broadcast' },
    { id: 'flags', label: '🚩 Flags' },
    { id: 'housemates', label: '🏠 Housemates' },
    { id: 'predictions', label: '🏆 Predictions' },
    { id: 'ads', label: '📢 Ads' },
    { id: 'feedback', label: '💬 Feedback' },
    { id: 'settings', label: '⚙️ Settings' }
  ];
  
  let content = '';
  switch(adminCurrentView) {
    case 'dashboard': content = renderAdminDashboard(); break;
    case 'users': content = renderAdminUsers(); break;
    case 'feed': content = renderAdminFeed(); break;
    case 'wordgame': content = renderAdminWordGame(); break;
    case 'notifications': content = renderAdminNotifications(); break;
    case 'broadcast': content = renderAdminBroadcast(); break;
    case 'flags': content = renderAdminFlags(); break;
    case 'housemates': content = renderAdminHousemates(); break;
    case 'predictions': content = renderAdminPredictions(); break;
    case 'ads': content = renderAdminAds(); break;
    case 'feedback': 
      content = `
        <div class="admin-feedback">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;">
            <h2 style="color:#fffffe;font-size:1.2rem;">💬 Feedback & Reports</h2>
            <button onclick="loadAdminFeedback()" style="background:#e94560;border:none;color:white;padding:0.3rem 1rem;border-radius:12px;cursor:pointer;font-size:0.8rem;">🔄 Refresh</button>
          </div>
          <div id="adminFeedbackContainer">
            <div style="text-align:center;padding:2rem;color:#6b7280;">
              <div class="spinner" style="width:30px;height:30px;border:3px solid #2a2a4e;border-top-color:#e94560;border-radius:50%;animation:spin 1s linear infinite;margin:0 auto 10px;"></div>
              <p>Loading feedback...</p>
            </div>
          </div>
        </div>
      `;
      setTimeout(loadAdminFeedback, 100);
      break;
    case 'settings':
      content = renderAdminSettings();
      setTimeout(loadAdminSettingsUI, 100);
      break;
    default: content = renderAdminDashboard();
  }
  
  logScreenView('admin_' + adminCurrentView);
  
  root.innerHTML = `
    <div class="admin-app">
      <div class="admin-top-bar">
        <div class="top-bar-left">
          <span class="app-title">👑 Admin Panel</span>
        </div>
        <div class="top-bar-right">
          <button class="icon-btn" onclick="handleLogoutWithDialog()" title="Logout">🚪</button>
        </div>
      </div>
      
      <div class="admin-tabs">
        ${tabs.map(tab => `
          <button class="admin-tab ${adminCurrentView === tab.id ? 'active' : ''}" onclick="switchAdminView('${tab.id}')">
            ${tab.label}
          </button>
        `).join('')}
      </div>
      
      <div class="admin-content">
        ${content}
      </div>
    </div>
  `;
}

function renderAdminDashboard() {
  const totalUsers = allUsers.length;
  const totalNotifications = notifications.length;
  const unreadNotifications = notifications.filter(n => !n.read).length;
  const totalPosts = communityPosts.length + feedPosts.length;
  const totalFlags = flaggedPosts.size;
  const totalHousemates = housemates.length;
  const totalPredictions = predictions.length;
  const totalAds = allAds.filter(a => a.status === 'approved').length;
  const pendingAds = allAds.filter(a => a.status === 'pending_payment' || a.status === 'pending').length;
  const totalLikes = communityPosts.reduce((sum, p) => sum + (p.likes || 0), 0);
  const totalComments = communityPosts.reduce((sum, p) => sum + (p.comments || 0), 0);
  
  return `
    <div class="admin-dashboard">
      <h2 style="color:#fffffe;font-size:1.2rem;margin-bottom:1rem;">📊 Overview</h2>
      
      <div class="admin-stats-grid">
        <div class="admin-stat-card">
          <div class="stat-icon">👥</div>
          <div class="stat-number">${totalUsers}</div>
          <div class="stat-label">Total Users</div>
        </div>
        <div class="admin-stat-card">
          <div class="stat-icon">📨</div>
          <div class="stat-number">${totalNotifications}</div>
          <div class="stat-label">Total Notifications</div>
        </div>
        <div class="admin-stat-card">
          <div class="stat-icon">🔴</div>
          <div class="stat-number" style="color:#e94560;">${unreadNotifications}</div>
          <div class="stat-label">Unread</div>
        </div>
        <div class="admin-stat-card">
          <div class="stat-icon">📝</div>
          <div class="stat-number">${totalPosts}</div>
          <div class="stat-label">Total Posts</div>
        </div>
        <div class="admin-stat-card">
          <div class="stat-icon">🚩</div>
          <div class="stat-number" style="color:#ff9800;">${totalFlags}</div>
          <div class="stat-label">Flagged Posts</div>
        </div>
        <div class="admin-stat-card">
          <div class="stat-icon">🏠</div>
          <div class="stat-number" style="color:#FFB300;">${totalHousemates}</div>
          <div class="stat-label">Housemates</div>
        </div>
        <div class="admin-stat-card">
          <div class="stat-icon">🏆</div>
          <div class="stat-number" style="color:#FFB300;">${totalPredictions}</div>
          <div class="stat-label">Predictions</div>
        </div>
        <div class="admin-stat-card">
          <div class="stat-icon">📢</div>
          <div class="stat-number" style="color:#FFB300;">${totalAds}</div>
          <div class="stat-label">Active Ads</div>
        </div>
        <div class="admin-stat-card">
          <div class="stat-icon">⏳</div>
          <div class="stat-number" style="color:#FF9800;">${pendingAds}</div>
          <div class="stat-label">Pending Ads</div>
        </div>
      </div>
      
      <div style="margin-top:1.5rem;">
        <h3 style="color:#fffffe;font-size:1rem;margin-bottom:0.5rem;">🕐 Recent Activity</h3>
        <div style="background:#1a1a2e;border-radius:12px;padding:0.5rem;border:1px solid #2a2a4e;">
          ${feedPosts.slice(0, 5).map(p => `
            <div style="padding:0.5rem;border-bottom:1px solid #2a2a4e;color:#a7a9be;font-size:0.85rem;">
              <span style="color:#fffffe;">${p.user}</span> posted: "${p.content.substring(0, 60)}${p.content.length > 60 ? '...' : ''}"
            </div>
          `).join('') || '<div style="color:#6b7280;padding:0.5rem;text-align:center;">No recent activity</div>'}
        </div>
      </div>
    </div>
  `;
}

function renderAdminUsers() {
  return `
    <div class="admin-users">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;">
        <h2 style="color:#fffffe;font-size:1.2rem;">👥 All Users (${allUsers.length})</h2>
        <button onclick="loadAllUsers();renderAdminApp();" style="background:#e94560;border:none;color:white;padding:0.3rem 1rem;border-radius:12px;cursor:pointer;">🔄 Refresh</button>
      </div>
      
      <div style="background:#1a1a2e;border-radius:12px;overflow:hidden;border:1px solid #2a2a4e;">
        <div style="display:grid;grid-template-columns:2fr 2fr 1fr 1fr;gap:0.5rem;padding:0.8rem;background:#0f0e17;color:#a7a9be;font-size:0.8rem;font-weight:600;border-bottom:1px solid #2a2a4e;">
          <span>Username</span>
          <span>Email</span>
          <span>UID</span>
          <span style="text-align:center;">Actions</span>
        </div>
        ${allUsers.map(user => `
          <div class="admin-user-row" style="display:grid;grid-template-columns:2fr 2fr 1fr 1fr;gap:0.5rem;padding:0.6rem 0.8rem;border-bottom:1px solid #1a1a2e;color:#e5e7eb;font-size:0.8rem;align-items:center;">
            <span>${user.username || 'N/A'}</span>
            <span style="font-size:0.75rem;">${user.email || 'N/A'}</span>
            <span style="font-size:0.6rem;color:#6b7280;font-family:monospace;cursor:pointer;" onclick="copyToClipboard('${user.id}')" title="Click to copy UID">${user.id.substring(0, 12)}...</span>
            <div style="display:flex;gap:0.3rem;justify-content:center;">
              <button onclick="copyToClipboard('${user.id}')" style="background:#2a2a4e;border:none;color:#a7a9be;padding:0.2rem 0.5rem;border-radius:6px;font-size:0.6rem;cursor:pointer;" title="Copy UID">📋</button>
              <button onclick="deleteUserAccount('${user.id}')" style="background:#e94560;border:none;color:white;padding:0.2rem 0.5rem;border-radius:6px;font-size:0.6rem;cursor:pointer;" title="Delete User">🗑️</button>
            </div>
          </div>
        `).join('')}
      </div>
      <div style="color:#6b7280;font-size:0.7rem;margin-top:0.5rem;">Click 📋 to copy UID • Click 🗑️ to delete user</div>
    </div>
  `;
}

// ============================================================
// ===== ADMIN FEED =====
// ============================================================

function renderAdminFeed() {
  return `
    <div class="admin-feed">
      <h2 style="color:#fffffe;font-size:1.2rem;margin-bottom:1rem;">📰 Create Feed Post</h2>
      
      <div style="background:#1a1a2e;border-radius:16px;padding:1.5rem;border:1px solid #2a2a4e;margin-bottom:1rem;">
        <div style="margin-bottom:1rem;">
          <label style="color:#a7a9be;font-size:0.9rem;display:block;margin-bottom:0.3rem;">Post Type</label>
          <select id="adminFeedType" style="width:100%;padding:0.6rem;background:#0f0e17;border:1px solid #2a2a4e;border-radius:10px;color:#fffffe;font-size:0.9rem;" onchange="toggleAdminFeedOptions()">
            <option value="text">Text</option>
            <option value="poll">Poll</option>
            <option value="image">Image</option>
          </select>
        </div>
        
        <div style="margin-bottom:1rem;">
          <label style="color:#a7a9be;font-size:0.9rem;display:block;margin-bottom:0.3rem;">Content</label>
          <textarea id="adminFeedContent" style="width:100%;background:#0f0e17;border:1px solid #2a2a4e;border-radius:10px;color:#fffffe;padding:0.8rem;font-size:0.9rem;resize:vertical;min-height:80px;font-family:inherit;" placeholder="Enter post content..."></textarea>
        </div>
        
        <div id="adminPollOptions" style="display:none;margin-bottom:1rem;">
          <label style="color:#a7a9be;font-size:0.9rem;display:block;margin-bottom:0.3rem;">Poll Options (comma separated)</label>
          <input type="text" id="adminPollOptionsInput" style="width:100%;padding:0.6rem;background:#0f0e17;border:1px solid #2a2a4e;border-radius:10px;color:#fffffe;font-size:0.9rem;" placeholder="Option 1, Option 2, Option 3">
        </div>
        
        <div id="adminFeedImageUpload" style="display:none;margin-bottom:1rem;">
          <label style="color:#a7a9be;font-size:0.9rem;display:block;margin-bottom:0.3rem;">Image</label>
          <input type="file" id="adminFeedImage" accept="image/*" onchange="previewAdminFeedImage(event)">
          <div id="adminFeedImagePreview"></div>
        </div>
        
        <button onclick="submitAdminFeedPost()" style="width:100%;padding:0.8rem;background:#e94560;border:none;border-radius:10px;color:white;font-weight:600;cursor:pointer;">Create Post</button>
      </div>
      
      <h3 style="color:#fffffe;font-size:1rem;margin:1rem 0;">📋 Existing Feed Posts</h3>
      ${feedPosts.map(post => `
        <div style="background:#1a1a2e;border-radius:12px;padding:1rem;margin-bottom:0.5rem;border:1px solid #2a2a4e;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <span style="color:#e94560;font-weight:600;">${post.type.toUpperCase()}</span>
            <span style="color:#6b7280;font-size:0.7rem;">${post.time}</span>
          </div>
          <div style="color:#e5e7eb;font-size:0.9rem;margin-top:0.3rem;">${post.content}</div>
          <div style="color:#6b7280;font-size:0.7rem;margin-top:0.3rem;">❤️ ${post.likes} 💬 ${post.comments}</div>
        </div>
      `).join('') || '<div style="color:#6b7280;text-align:center;padding:1rem;">No feed posts yet.</div>'}
    </div>
  `;
}

function toggleAdminFeedOptions() {
  const type = document.getElementById('adminFeedType').value;
  document.getElementById('adminPollOptions').style.display = type === 'poll' ? 'block' : 'none';
  document.getElementById('adminFeedImageUpload').style.display = type === 'image' ? 'block' : 'none';
}

let adminFeedImageFile = null;

function previewAdminFeedImage(event) {
  const file = event.target.files[0];
  if (file) {
    adminFeedImageFile = file;
    const reader = new FileReader();
    reader.onload = function(e) {
      document.getElementById('adminFeedImagePreview').innerHTML = `<img src="${e.target.result}" style="max-width:100%;max-height:200px;border-radius:8px;margin-top:0.5rem;">`;
    };
    reader.readAsDataURL(file);
  }
}

async function submitAdminFeedPost() {
  const type = document.getElementById('adminFeedType').value;
  const content = document.getElementById('adminFeedContent').value.trim();
  if (!content) {
    alert('Please enter content.');
    return;
  }
  
  let imageUrls = [];
  let pollOptions = [];
  
  if (type === 'poll') {
    const optionsInput = document.getElementById('adminPollOptionsInput').value;
    pollOptions = optionsInput.split(',').map(s => s.trim()).filter(s => s);
    if (pollOptions.length < 2) {
      alert('Please enter at least 2 poll options separated by commas.');
      return;
    }
  }
  
  if (type === 'image' && adminFeedImageFile) {
    if (adminFeedImageFile.size > MAX_UPLOAD_SIZE) {
      alert('Image is larger than 3MB. Please select a smaller image.');
      adminFeedImageFile = null;
      document.getElementById('adminFeedImagePreview').innerHTML = '';
      document.getElementById('adminFeedImage').value = '';
      return;
    }
    
    try {
      const compressed = await compressImage(adminFeedImageFile, 800, 0.7);
      const urls = await uploadMultipleToR2([compressed], 'feed');
      if (urls && urls.length > 0) {
        imageUrls = urls;
      } else {
        throw new Error('Image upload failed');
      }
    } catch (error) {
      console.error('Image upload error:', error);
      if (imageUrls.length > 0) {
        await deleteR2Images(imageUrls);
      }
      alert('Failed to upload image. Please try again.');
      return;
    }
  }
  
  const postData = {
    type: type,
    content: content,
    imageUrls: imageUrls,
    pollOptions: pollOptions,
    user: 'DHouse Admin'
  };
  
  const success = await createFeedPost(postData);
  
  if (!success && imageUrls.length > 0) {
    await deleteR2Images(imageUrls);
  }
  
  if (success) {
    document.getElementById('adminFeedContent').value = '';
    document.getElementById('adminPollOptionsInput').value = '';
    document.getElementById('adminFeedImagePreview').innerHTML = '';
    adminFeedImageFile = null;
    document.getElementById('adminFeedImage').value = '';
  }
}

// ============================================================
// ===== ADMIN WORD GAME =====
// ============================================================

function renderAdminWordGame() {
  return `
    <div class="admin-wordgame">
      <h2 style="color:#fffffe;font-size:1.2rem;margin-bottom:1rem;">🎯 Manage Word Games</h2>
      
      <div style="background:#1a1a2e;border-radius:16px;padding:1.5rem;border:1px solid #2a2a4e;margin-bottom:1rem;">
        <h3 style="color:#fffffe;font-size:1rem;margin-bottom:0.5rem;">Add New Word</h3>
        
        <div style="margin-bottom:0.5rem;">
          <label style="color:#a7a9be;font-size:0.9rem;display:block;margin-bottom:0.3rem;">Word (answer)</label>
          <input type="text" id="adminWordInput" style="width:100%;padding:0.6rem;background:#0f0e17;border:1px solid #2a2a4e;border-radius:10px;color:#fffffe;font-size:0.9rem;" placeholder="e.g., BBNaija">
        </div>
        
        <div style="margin-bottom:0.5rem;">
          <label style="color:#a7a9be;font-size:0.9rem;display:block;margin-bottom:0.3rem;">Hint</label>
          <input type="text" id="adminHintInput" style="width:100%;padding:0.6rem;background:#0f0e17;border:1px solid #2a2a4e;border-radius:10px;color:#fffffe;font-size:0.9rem;" placeholder="e.g., Reality TV show in Nigeria">
        </div>
        
        <div style="margin-bottom:0.5rem;">
          <label style="color:#a7a9be;font-size:0.9rem;display:block;margin-bottom:0.3rem;">Sponsor Image (optional)</label>
          <input type="file" id="adminSponsorImage" accept="image/*" onchange="previewAdminSponsorImage(event)">
          <div id="adminSponsorImagePreview"></div>
        </div>
        
        <div style="margin-bottom:0.5rem;">
          <label style="color:#a7a9be;font-size:0.9rem;display:block;margin-bottom:0.3rem;">Date (YYYY-MM-DD)</label>
          <input type="date" id="adminWordDate" style="width:100%;padding:0.6rem;background:#0f0e17;border:1px solid #2a2a4e;border-radius:10px;color:#fffffe;font-size:0.9rem;">
        </div>
        
        <div style="margin-bottom:0.5rem;">
          <label style="color:#a7a9be;font-size:0.9rem;display:block;margin-bottom:0.3rem;">Colors (Hex codes)</label>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.5rem;">
            <div><label style="color:#6b7280;font-size:0.7rem;">Heading</label><input type="color" id="colorHeading" value="#e94560" style="width:100%;padding:0.3rem;background:#0f0e17;border:1px solid #2a2a4e;border-radius:6px;"></div>
            <div><label style="color:#6b7280;font-size:0.7rem;">Answer Letters</label><input type="color" id="colorAnswer" value="#FFB300" style="width:100%;padding:0.3rem;background:#0f0e17;border:1px solid #2a2a4e;border-radius:6px;"></div>
            <div><label style="color:#6b7280;font-size:0.7rem;">Underscores</label><input type="color" id="colorUnderscore" value="#fffffe" style="width:100%;padding:0.3rem;background:#0f0e17;border:1px solid #2a2a4e;border-radius:6px;"></div>
            <div><label style="color:#6b7280;font-size:0.7rem;">Hint</label><input type="color" id="colorHint" value="#a7a9be" style="width:100%;padding:0.3rem;background:#0f0e17;border:1px solid #2a2a4e;border-radius:6px;"></div>
            <div><label style="color:#6b7280;font-size:0.7rem;">Keyboard</label><input type="color" id="colorKeyboard" value="#2a2a4e" style="width:100%;padding:0.3rem;background:#0f0e17;border:1px solid #2a2a4e;border-radius:6px;"></div>
            <div><label style="color:#6b7280;font-size:0.7rem;">Score</label><input type="color" id="colorScore" value="#e94560" style="width:100%;padding:0.3rem;background:#0f0e17;border:1px solid #2a2a4e;border-radius:6px;"></div>
          </div>
        </div>
        
        <button onclick="submitAdminWordGame()" style="width:100%;padding:0.8rem;background:#e94560;border:none;border-radius:10px;color:white;font-weight:600;cursor:pointer;">Add Word Game</button>
      </div>
      
      <h3 style="color:#fffffe;font-size:1rem;margin:1rem 0;">📋 Existing Words</h3>
      ${dailyWords.map(word => `
        <div style="background:#1a1a2e;border-radius:12px;padding:1rem;margin-bottom:0.5rem;border:1px solid #2a2a4e;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <span style="color:#e94560;font-weight:600;">${word.word}</span>
            <span style="color:#6b7280;font-size:0.7rem;">${word.date}</span>
          </div>
          <div style="color:#a7a9be;font-size:0.85rem;margin-top:0.3rem;">💡 ${word.hint}</div>
          <div style="color:#6b7280;font-size:0.7rem;margin-top:0.3rem;display:flex;gap:0.5rem;flex-wrap:wrap;">
            <button onclick="viewWordSubmissions('${word.id}')" style="background:#2a2a4e;border:none;color:#a7a9be;padding:0.2rem 0.8rem;border-radius:6px;cursor:pointer;font-size:0.7rem;">View Submissions</button>
            <button onclick="deleteWordGame('${word.id}')" style="background:#e94560;border:none;color:white;padding:0.2rem 0.8rem;border-radius:6px;cursor:pointer;font-size:0.7rem;">🗑️ Delete</button>
          </div>
        </div>
      `).join('') || '<div style="color:#6b7280;text-align:center;padding:1rem;">No words added yet.</div>'}
      
      <div id="wordSubmissionsContainer" style="display:none;margin-top:1rem;background:#1a1a2e;border-radius:16px;padding:1rem;border:1px solid #2a2a4e;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem;">
          <h4 style="color:#fffffe;">Submissions</h4>
          <button onclick="document.getElementById('wordSubmissionsContainer').style.display='none'" style="background:none;border:none;color:#e94560;cursor:pointer;">✕</button>
        </div>
        <div id="wordSubmissionsList"></div>
        <div style="margin-top:1rem;">
          <label style="color:#a7a9be;font-size:0.9rem;display:block;margin-bottom:0.3rem;">📨 Send Message to All Winners</label>
          <textarea id="wordSubmissionsMessage" style="width:100%;background:#0f0e17;border:1px solid #2a2a4e;border-radius:10px;color:#fffffe;padding:0.8rem;font-size:0.9rem;resize:vertical;min-height:60px;font-family:inherit;" placeholder="Type a message to send to all users who got this word correct..."></textarea>
          <button onclick="sendMessageToWordSubmissions()" style="margin-top:0.5rem;padding:0.6rem 1.5rem;background:#e94560;border:none;border-radius:10px;color:white;font-weight:600;cursor:pointer;">📤 Send Message to All Winners</button>
        </div>
      </div>
    </div>
  `;
}

let adminSponsorImageFile = null;

function previewAdminSponsorImage(event) {
  const file = event.target.files[0];
  if (file) {
    adminSponsorImageFile = file;
    const reader = new FileReader();
    reader.onload = function(e) {
      document.getElementById('adminSponsorImagePreview').innerHTML = `<img src="${e.target.result}" style="max-width:100%;max-height:150px;border-radius:8px;margin-top:0.5rem;">`;
    };
    reader.readAsDataURL(file);
  }
}

async function submitAdminWordGame() {
  const wordInput = document.getElementById('adminWordInput');
  const hintInput = document.getElementById('adminHintInput');
  const dateInput = document.getElementById('adminWordDate');
  
  if (!wordInput || !hintInput || !dateInput) {
    alert('Form elements not found. Please refresh and try again.');
    return;
  }
  
  const word = wordInput.value.trim();
  const hint = hintInput.value.trim();
  const date = dateInput.value;
  
  if (!word || !hint || !date) {
    alert('Please fill in word, hint, and date.');
    return;
  }
  
  let sponsorImage = '';
  let imageUrl = null;
  
  if (adminSponsorImageFile) {
    if (adminSponsorImageFile.size > MAX_UPLOAD_SIZE) {
      alert('Sponsor image is larger than 3MB. Please select a smaller image.');
      adminSponsorImageFile = null;
      document.getElementById('adminSponsorImagePreview').innerHTML = '';
      document.getElementById('adminSponsorImage').value = '';
      return;
    }
    
    try {
      const compressed = await compressImage(adminSponsorImageFile, 400, 0.7);
      const urls = await uploadMultipleToR2([compressed], 'sponsors');
      if (urls && urls.length > 0) {
        sponsorImage = urls[0];
        imageUrl = urls[0];
      } else {
        throw new Error('Image upload failed');
      }
    } catch (error) {
      console.error('Sponsor image upload error:', error);
      alert('Failed to upload sponsor image.');
      return;
    }
  }
  
  const colors = {
    heading: document.getElementById('colorHeading').value,
    answer: document.getElementById('colorAnswer').value,
    underscore: document.getElementById('colorUnderscore').value,
    hint: document.getElementById('colorHint').value,
    keyboard: document.getElementById('colorKeyboard').value,
    score: document.getElementById('colorScore').value
  };
  
  const success = await addDailyWord(word, hint, sponsorImage, colors, date);
  
  if (!success && imageUrl) {
    await deleteR2Images([imageUrl]);
  }
  
  if (success) {
    wordInput.value = '';
    hintInput.value = '';
    dateInput.value = '';
    document.getElementById('adminSponsorImagePreview').innerHTML = '';
    adminSponsorImageFile = null;
    document.getElementById('adminSponsorImage').value = '';
  }
}

async function viewWordSubmissions(wordId) {
  const container = document.getElementById('wordSubmissionsContainer');
  const list = document.getElementById('wordSubmissionsList');
  if (!container || !list) return;
  
  container.style.display = 'block';
  list.innerHTML = 'Loading...';
  
  const submissions = await loadWordSubmissionsForAdmin(wordId);
  currentWordSubmissionsForMessage = submissions;
  
  if (submissions.length === 0) {
    list.innerHTML = '<div style="color:#6b7280;padding:0.5rem;">No submissions yet.</div>';
    return;
  }
  
  let html = `
    <div style="display:grid;grid-template-columns:2fr 2fr 1fr;gap:0.5rem;padding:0.5rem;background:#0f0e17;border-radius:8px;color:#a7a9be;font-size:0.7rem;font-weight:600;margin-bottom:0.3rem;">
      <span>Username</span>
      <span>Email</span>
      <span>UID</span>
    </div>
  `;
  submissions.forEach(sub => {
    html += `
      <div style="display:grid;grid-template-columns:2fr 2fr 1fr;gap:0.5rem;padding:0.3rem 0.5rem;background:#0f0e17;border-radius:6px;margin-bottom:0.2rem;font-size:0.7rem;color:#e5e7eb;cursor:pointer;" onclick="copyToClipboard('${sub.userId}')">
        <span>${sub.username || 'N/A'}</span>
        <span>${sub.email || 'N/A'}</span>
        <span style="color:#6b7280;font-family:monospace;">${sub.userId.substring(0, 12)}...</span>
      </div>
    `;
  });
  list.innerHTML = html;
}

async function sendMessageToWordSubmissions() {
  const textarea = document.getElementById('wordSubmissionsMessage');
  const message = textarea ? textarea.value.trim() : '';
  
  if (!message) {
    alert('Please enter a message.');
    return;
  }
  
  if (currentWordSubmissionsForMessage.length === 0) {
    alert('No users to send to. Load submissions first.');
    return;
  }
  
  const uids = currentWordSubmissionsForMessage.map(sub => sub.userId).filter(uid => uid);
  if (uids.length === 0) {
    alert('No valid user IDs found.');
    return;
  }
  
  if (confirm(`Send this message to ${uids.length} users who got the word correct?\n\n"${message}"`)) {
    const success = await sendNotificationToList(uids, message);
    if (success) {
      alert(`✅ Message sent to ${uids.length} users!`);
      textarea.value = '';
    } else {
      alert('❌ Failed to send message.');
    }
  }
}

function renderAdminNotifications() {
  const unread = notifications.filter(n => !n.read);
  const read = notifications.filter(n => n.read);
  
  return `
    <div class="admin-notifications">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;">
        <h2 style="color:#fffffe;font-size:1.2rem;">📨 Notifications</h2>
        <span style="color:#e94560;font-size:0.8rem;">${unread.length} unread</span>
      </div>
      
      <div style="margin-bottom:1rem;">
        <h3 style="color:#a7a9be;font-size:0.9rem;margin-bottom:0.5rem;">🔴 Unread</h3>
        ${unread.map(n => `
          <div class="admin-notif-item unread" onclick="openNotificationDetail(getNotificationById('${n.id}'))">
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <div>
                <div style="color:#fffffe;font-weight:500;">${n.fromName}</div>
                <div style="color:#a7a9be;font-size:0.8rem;">${n.message}</div>
                <div style="color:#6b7280;font-size:0.7rem;">${n.time}</div>
              </div>
              <span style="color:#e94560;font-size:0.7rem;">● New</span>
            </div>
          </div>
        `).join('') || '<div style="color:#6b7280;padding:0.5rem;">No unread notifications</div>'}
      </div>
      
      <div>
        <h3 style="color:#a7a9be;font-size:0.9rem;margin-bottom:0.5rem;">✅ Read</h3>
        ${read.slice(0, 10).map(n => `
          <div class="admin-notif-item read" onclick="openNotificationDetail(getNotificationById('${n.id}'))">
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <div>
                <div style="color:#6b7280;font-weight:500;">${n.fromName}</div>
                <div style="color:#6b7280;font-size:0.8rem;">${n.message}</div>
                <div style="color:#555;font-size:0.7rem;">${n.time}</div>
              </div>
            </div>
          </div>
        `).join('') || '<div style="color:#6b7280;padding:0.5rem;">No read notifications</div>'}
        ${read.length > 10 ? `<div style="color:#6b7280;font-size:0.7rem;text-align:center;padding:0.3rem;">+${read.length - 10} more</div>` : ''}
      </div>
    </div>
  `;
}

function renderAdminBroadcast() {
  return `
    <div class="admin-broadcast">
      <h2 style="color:#fffffe;font-size:1.2rem;margin-bottom:1rem;">📢 Send Broadcast</h2>
      
      <div style="background:#1a1a2e;border-radius:16px;padding:1.5rem;margin-bottom:1rem;border:1px solid #2a2a4e;">
        <h3 style="color:#fffffe;font-size:1rem;margin-bottom:0.5rem;">📨 Send to All Users</h3>
        <p style="color:#6b7280;font-size:0.8rem;margin-bottom:0.5rem;">This will send a notification to all registered users.</p>
        <textarea id="adminBroadcastAll" style="width:100%;background:#0f0e17;border:1px solid #2a2a4e;border-radius:10px;color:#fffffe;padding:0.8rem;font-size:0.9rem;resize:vertical;min-height:80px;font-family:inherit;" placeholder="Enter broadcast message..."></textarea>
        <button onclick="sendAdminBroadcastToAll()" style="margin-top:0.5rem;padding:0.6rem 1.5rem;background:#e94560;color:white;border:none;border-radius:10px;font-weight:600;cursor:pointer;">📤 Send to All (${allUsers.length} users)</button>
      </div>
      
      <div style="background:#1a1a2e;border-radius:16px;padding:1.5rem;border:1px solid #2a2a4e;">
        <h3 style="color:#fffffe;font-size:1rem;margin-bottom:0.5rem;">👤 Send to Single User (by UID)</h3>
        <p style="color:#6b7280;font-size:0.8rem;margin-bottom:0.5rem;">Paste the user's UID to send a personal notification.</p>
        <div style="display:flex;gap:0.5rem;margin-bottom:0.5rem;">
          <input type="text" id="adminBroadcastUid" placeholder="Paste user UID here..." style="flex:1;background:#0f0e17;border:1px solid #2a2a4e;border-radius:10px;color:#fffffe;padding:0.6rem;font-size:0.9rem;">
        </div>
        <textarea id="adminBroadcastSingle" style="width:100%;background:#0f0e17;border:1px solid #2a2a4e;border-radius:10px;color:#fffffe;padding:0.8rem;font-size:0.9rem;resize:vertical;min-height:60px;font-family:inherit;" placeholder="Enter personal message..."></textarea>
        <button onclick="sendAdminBroadcastToSingle()" style="margin-top:0.5rem;padding:0.6rem 1.5rem;background:#e94560;color:white;border:none;border-radius:10px;font-weight:600;cursor:pointer;">📤 Send to User</button>
      </div>
    </div>
  `;
}

function renderAdminFlags() {
  return `
    <div class="admin-flags">
      <h2 style="color:#fffffe;font-size:1.2rem;margin-bottom:1rem;">🚩 Flagged Posts</h2>
      <div id="flaggedPostsContainer">
        <div style="color:#6b7280;text-align:center;padding:1rem;">Loading flagged posts...</div>
      </div>
    </div>
  `;
}

async function loadFlaggedPostsForAdmin() {
  const container = document.getElementById('flaggedPostsContainer');
  if (!container) return;
  
  try {
    const flagged = await getFlaggedPosts();
    if (flagged.length === 0) {
      container.innerHTML = '<div style="color:#6b7280;text-align:center;padding:2rem;">✅ No flagged posts to review.</div>';
      return;
    }
    
    let html = '';
    for (const flag of flagged) {
      const post = communityPosts.find(p => p.id === flag.postId);
      html += `
        <div style="background:#1a1a2e;border-radius:12px;padding:1rem;margin-bottom:0.5rem;border:1px solid #2a2a4e;">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;">
            <div>
              <div style="color:#ff9800;font-weight:600;">🚩 Flagged by ${flag.username || 'Unknown'}</div>
              <div style="color:#a7a9be;font-size:0.8rem;">Reason: ${flag.reason}</div>
              <div style="color:#6b7280;font-size:0.7rem;">${flag.flaggedAt?.toDate?.()?.toLocaleString() || 'Just now'}</div>
              ${post ? `
                <div style="color:#e5e7eb;font-size:0.85rem;margin-top:0.3rem;padding:0.5rem;background:#0f0e17;border-radius:8px;cursor:pointer;" onclick="openFullPostView('${post.id}')">
                  <strong>Post content:</strong> ${post.content.substring(0, 100)}${post.content.length > 100 ? '...' : ''}
                  <div style="color:#e94560;font-size:0.7rem;margin-top:2px;">Tap to view full post →</div>
                </div>
              ` : '<div style="color:#6b7280;font-size:0.8rem;">Post may have been deleted</div>'}
            </div>
            <div style="display:flex;gap:0.3rem;">
              ${post ? `
                <button onclick="deleteUserPost('${post.id}', event);setTimeout(loadFlaggedPostsForAdmin,500);" style="background:#e94560;border:none;color:white;padding:0.3rem 0.8rem;border-radius:6px;cursor:pointer;font-size:0.7rem;">🗑️ Delete Post</button>
              ` : ''}
              <button onclick="resolveFlaggedPost('${flag.id}');setTimeout(loadFlaggedPostsForAdmin,500);" style="background:#4CAF50;border:none;color:white;padding:0.3rem 0.8rem;border-radius:6px;cursor:pointer;font-size:0.7rem;">✅ Resolve</button>
            </div>
          </div>
        </div>
      `;
    }
    container.innerHTML = html;
  } catch (error) {
    console.error('Error loading flagged posts:', error);
    container.innerHTML = '<div style="color:#e94560;text-align:center;padding:1rem;">❌ Error loading flagged posts.</div>';
  }
}

async function sendAdminBroadcastToAll() {
  const textarea = document.getElementById('adminBroadcastAll');
  const message = textarea ? textarea.value : '';
  
  if (!message.trim()) {
    alert('Please enter a message.');
    return;
  }
  
  if (confirm(`Send this notification to ALL ${allUsers.length} users?\n\n"${message}"`)) {
    const success = await sendNotificationToAll(message);
    if (success) {
      alert(`✅ Notification sent to ${allUsers.length} users!`);
      if (textarea) textarea.value = '';
    } else {
      alert('❌ Failed to send notification.');
    }
  }
}

async function sendAdminBroadcastToSingle() {
  const uidInput = document.getElementById('adminBroadcastUid');
  const textarea = document.getElementById('adminBroadcastSingle');
  const uid = uidInput ? uidInput.value.trim() : '';
  const message = textarea ? textarea.value : '';
  
  if (!uid) {
    alert('Please enter a user UID.');
    return;
  }
  
  if (!message.trim()) {
    alert('Please enter a message.');
    return;
  }
  
  const user = allUsers.find(u => u.id === uid);
  const userName = user?.username || 'User';
  
  if (confirm(`Send notification to "${userName}"?\n\n"${message}"`)) {
    const success = await sendNotificationToUser(uid, message);
    if (success) {
      alert('✅ Notification sent!');
      if (textarea) textarea.value = '';
      if (uidInput) uidInput.value = '';
    } else {
      alert('❌ Failed to send notification.');
    }
  }
}

function switchAdminView(view) {
  adminCurrentView = view;
  renderAdminApp();
  if (view === 'flags') {
    setTimeout(loadFlaggedPostsForAdmin, 100);
  }
}

function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      showToast('✅ UID copied to clipboard!', true);
    }).catch(() => {
      fallbackCopyToClipboard(text);
    });
  } else {
    fallbackCopyToClipboard(text);
  }
}

function fallbackCopyToClipboard(text) {
  const input = document.createElement('input');
  input.value = text;
  document.body.appendChild(input);
  input.select();
  try {
    document.execCommand('copy');
    showToast('✅ UID copied to clipboard!', true);
  } catch (e) {
    showToast('❌ Failed to copy. Please copy manually.', false);
  }
  document.body.removeChild(input);
}

// ============================================================
// ===== ADMIN FEEDBACK VIEW =====
// ============================================================

async function loadAdminFeedback() {
  const container = document.getElementById('adminFeedbackContainer');
  if (!container) {
    console.log('⏳ Container not ready, retrying...');
    setTimeout(loadAdminFeedback, 500);
    return;
  }
  
  try {
    console.log('📥 Loading feedback...');
    const feedbackSnapshot = await db.collection('feedback')
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get();
    
    console.log(`📥 Found ${feedbackSnapshot.size} feedback entries`);
    
    if (feedbackSnapshot.empty) {
      container.innerHTML = `
        <div style="text-align:center;padding:3rem;color:#6b7280;background:#1a1a2e;border-radius:16px;border:1px solid #2a2a4e;">
          <p style="font-size:3rem;margin-bottom:0.5rem;">💬</p>
          <p>No feedback or reports yet.</p>
          <p style="font-size:0.8rem;margin-top:0.5rem;">Users can send feedback from the Settings screen.</p>
        </div>
      `;
      return;
    }
    
    let html = `
      <div style="margin-bottom:1rem;color:#6b7280;font-size:0.8rem;text-align:center;">
        Showing ${feedbackSnapshot.size} feedback entries
      </div>
    `;
    
    feedbackSnapshot.forEach(doc => {
      const data = doc.data();
      const date = data.createdAt?.toDate?.()?.toLocaleString() || 'Just now';
      const type = data.type || 'feedback';
      const status = data.status || 'pending';
      const username = data.username || 'Anonymous';
      const email = data.email || 'No email';
      const message = data.message || 'No message';
      
      const statusColor = status === 'pending' ? '#FF9800' : status === 'read' ? '#4CAF50' : '#6b7280';
      const statusLabel = status === 'pending' ? '⏳ Pending' : status === 'read' ? '✅ Read' : '📌 Resolved';
      const typeIcon = type === 'feedback' ? '💬' : '🐛';
      const typeLabel = type === 'feedback' ? 'Feedback' : 'Problem Report';
      
      html += `
        <div style="background:#1a1a2e;border-radius:12px;padding:1rem;margin-bottom:0.8rem;border:1px solid #2a2a4e;transition:all 0.2s;" id="feedback-${doc.id}">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:0.3rem;">
            <div style="display:flex;align-items:center;gap:0.5rem;">
              <span style="font-size:1.5rem;">${typeIcon}</span>
              <div>
                <div style="color:#fffffe;font-weight:600;">${escapeHtml(username)}</div>
                <div style="color:#6b7280;font-size:0.7rem;">${escapeHtml(email)}</div>
              </div>
            </div>
            <div style="display:flex;gap:0.3rem;align-items:center;flex-wrap:wrap;">
              <span style="background:rgba(233,69,96,0.15);color:#e94560;padding:0.1rem 0.6rem;border-radius:12px;font-size:0.6rem;font-weight:600;">${typeLabel}</span>
              <span style="background:${statusColor}30;color:${statusColor};padding:0.1rem 0.6rem;border-radius:12px;font-size:0.6rem;font-weight:600;">${statusLabel}</span>
              <span style="color:#6b7280;font-size:0.6rem;">${date}</span>
            </div>
          </div>
          
          <div style="margin:0.5rem 0;padding:0.5rem;background:#0f0e17;border-radius:8px;color:#e5e7eb;font-size:0.9rem;white-space:pre-wrap;word-wrap:break-word;">
            ${escapeHtml(message)}
          </div>
          
          <div style="display:flex;gap:0.3rem;flex-wrap:wrap;margin-top:0.5rem;">
            ${status === 'pending' ? `
              <button onclick="markFeedbackRead('${doc.id}')" style="background:#4CAF50;border:none;color:white;padding:0.2rem 0.8rem;border-radius:6px;cursor:pointer;font-size:0.7rem;">✅ Mark as Read</button>
            ` : ''}
            ${status === 'read' ? `
              <button onclick="markFeedbackResolved('${doc.id}')" style="background:#2196F3;border:none;color:white;padding:0.2rem 0.8rem;border-radius:6px;cursor:pointer;font-size:0.7rem;">📌 Resolve</button>
            ` : ''}
            <button onclick="deleteFeedback('${doc.id}')" style="background:#e94560;border:none;color:white;padding:0.2rem 0.8rem;border-radius:6px;cursor:pointer;font-size:0.7rem;">🗑️ Delete</button>
          </div>
        </div>
      `;
    });
    
    container.innerHTML = html;
    
  } catch (error) {
    console.error('Error loading feedback:', error);
    container.innerHTML = `
      <div style="text-align:center;padding:2rem;color:#e94560;background:#1a1a2e;border-radius:16px;border:1px solid #2a2a4e;">
        <p style="font-size:2rem;">❌</p>
        <p>Error loading feedback: ${error.message}</p>
        <button onclick="loadAdminFeedback()" style="margin-top:0.5rem;background:#e94560;border:none;color:white;padding:0.3rem 1rem;border-radius:12px;cursor:pointer;">Retry</button>
      </div>
    `;
  }
}

async function markFeedbackRead(feedbackId) {
  try {
    await db.collection('feedback').doc(feedbackId).update({
      status: 'read',
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    showToast('✅ Feedback marked as read', true);
    loadAdminFeedback();
  } catch (error) {
    console.error('Error marking feedback as read:', error);
    showToast('❌ Failed to update status', false);
  }
}

async function markFeedbackResolved(feedbackId) {
  try {
    await db.collection('feedback').doc(feedbackId).update({
      status: 'resolved',
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    showToast('✅ Feedback resolved!', true);
    loadAdminFeedback();
  } catch (error) {
    console.error('Error resolving feedback:', error);
    showToast('❌ Failed to update status', false);
  }
}

async function deleteFeedback(feedbackId) {
  if (!confirm('Delete this feedback/report permanently?')) return;
  try {
    await db.collection('feedback').doc(feedbackId).delete();
    showToast('✅ Feedback deleted', true);
    loadAdminFeedback();
  } catch (error) {
    console.error('Error deleting feedback:', error);
    showToast('❌ Failed to delete', false);
  }
}

// ============================================================
// ===== USER FEED VIEW (Feed tab) =====
// ============================================================

function renderSingleFeedPost(post) {
  const isExpanded = expandedPosts[post.id] || false;
  const maxLength = 150;
  const displayContent = isExpanded ? post.content : (post.content.length > maxLength ? post.content.substring(0, maxLength) + '...' : post.content);
  const showSeeMore = post.content.length > maxLength;
  
  const displayIcons = post.displayIcons && post.displayIcons.length > 0 
    ? post.displayIcons.join(' ') 
    : (post.type === 'alert' ? '⚠️' : post.type === 'result' ? '🏆' : '📊');
  
  const emojiReactions = post.emojiReactions || {};
  let emojiBadgesHtml = '';
  for (const [emoji, data] of Object.entries(emojiReactions)) {
    if (data.count > 0) {
      const userReacted = postEmojiReactions[`feed_emoji_${post.id}_${currentUser?.uid}`] === emoji;
      emojiBadgesHtml += `
        <div class="emoji-reaction-badge ${userReacted ? 'active' : ''}" onclick="addFeedEmojiReaction('${post.id}', '${emoji}')">
          <span class="emoji-reaction-emoji">${emoji}</span>
          <span class="emoji-reaction-count">${data.count}</span>
        </div>
      `;
    }
  }
  
  const addReactionHtml = `
    <button class="add-reaction-btn" onclick="showFeedEmojiPicker('${post.id}', event)" style="background:#2a2a4e;border:none;color:#a7a9be;padding:2px 10px;border-radius:12px;font-size:0.8rem;cursor:pointer;display:inline-flex;align-items:center;gap:4px;">
      😊 <span style="font-size:0.6rem;">react</span>
    </button>
  `;
  
  let imagesHTML = '';
  if (post.imageUrls && post.imageUrls.length > 0) {
    imagesHTML = `
      <div class="post-image-single" onclick="openFeedImageViewer('${post.id}')">
        <img src="${getOptimizedImageUrl(post.imageUrls[0], 600)}" alt="Post image" style="width:100%;max-height:400px;object-fit:cover;display:block;border-radius:12px;cursor:pointer;">
      </div>
    `;
  }
  
  let pollHTML = '';
  if (post.type === 'poll' && post.pollOptions && post.pollOptions.length > 0) {
    const totalVotes = Object.values(post.pollVotes || {}).reduce((a, b) => a + b, 0);
    pollHTML = `<div style="margin:0.5rem 0;">`;
    post.pollOptions.forEach((option, index) => {
      const count = (post.pollVotes && post.pollVotes[index]) || 0;
      const percentage = totalVotes > 0 ? (count / totalVotes * 100).toFixed(1) : 0;
      const userVoted = localStorage.getItem(`poll_vote_${post.id}`) === String(index);
      pollHTML += `
        <div style="margin-bottom:0.3rem;">
          <div style="display:flex;align-items:center;gap:8px;">
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer;color:#e5e7eb;font-size:0.85rem;flex:1;">
              <input type="radio" name="poll_${post.id}" value="${index}" ${userVoted ? 'checked' : ''} onchange="voteOnPoll('${post.id}', ${index})">
              ${option}
            </label>
            <span style="font-size:0.75rem;color:#6b7280;min-width:60px;text-align:right;">${count} (${percentage}%)</span>
          </div>
          <div style="height:4px;background:#0f0e17;border-radius:2px;overflow:hidden;margin-top:2px;">
            <div style="height:100%;width:${percentage}%;background:#e94560;border-radius:2px;"></div>
          </div>
        </div>
      `;
    });
    pollHTML += `</div>`;
  }
  
  const typeLabels = {
    'alert': '⚠️ DRAMA ALERT',
    'result': '🏆 LIVE RESULT',
    'poll': '📊 LIVE POLL',
    'text': '📰 FEED'
  };
  const typeLabel = typeLabels[post.type] || '📰 FEED';
  
  return `
    <div class="post-card feed-post" style="width:100%;position:relative;" data-post-id="${post.id}">
      <div class="post-header">
        <div class="post-user">
          <div class="avatar" style="background:#e94560;">👑</div>
          <div>
            <div class="post-username" style="font-size:1.1rem;">${displayIcons} ${post.user} <span style="font-size:0.7rem;color:#e94560;background:#e9456020;padding:0.1rem 0.5rem;border-radius:12px;">${typeLabel}</span></div>
            <div class="post-handle">· ${post.time}</div>
          </div>
        </div>
        <button class="icon-btn" style="font-size:1.2rem;">⋯</button>
      </div>
      <div class="post-content" style="word-wrap:break-word;overflow-wrap:break-word;font-size:1rem;">
        ${displayContent}
        ${showSeeMore ? `<span class="see-more" onclick="togglePostExpand('${post.id}')"> ${isExpanded ? 'See less' : 'See more'}</span>` : ''}
      </div>
      ${imagesHTML}
      ${pollHTML}
      ${emojiBadgesHtml ? `<div class="post-emoji-reactions" style="display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;padding-top:8px;border-top:1px solid #2a2a4e;">${emojiBadgesHtml} ${addReactionHtml}</div>` : `<div style="margin-top:8px;padding-top:8px;border-top:1px solid #2a2a4e;">${addReactionHtml}</div>`}
      <div class="post-actions">
        <button class="action-btn" onclick="likeFeedPost('${post.id}')">❤️ ${post.likes}</button>
        <button class="action-btn" onclick="commentFeedPost('${post.id}')">💬 ${post.comments}</button>
        <button class="action-btn" onclick="shareFeedPost('${post.id}')">↗️ ${post.shares || 0}</button>
      </div>
    </div>
  `;
}


// ============================================================
// ===== COMMENT ON FEED POST =====
// ============================================================

async function commentFeedPost(postId) {
  if (!currentUser) {
    showToast('Please sign in to comment', false);
    return;
  }
  
  // Find the post to make sure it exists
  const post = feedPosts.find(p => p.id === postId);
  if (!post) {
    showToast('Post not found.', false);
    return;
  }
  
  // Open the comment sheet for this feed post
  currentCommentPostId = postId;
  currentCommentPostType = 'feed';
  openCommentSheet(postId, 'feed');
}


// ============================================================
// ===== SHARE FEED POST =====
// ============================================================

async function shareFeedPost(postId) {
  const post = feedPosts.find(p => p.id === postId);
  if (!post) return;
  
  try {
    await db.collection('feed_posts').doc(postId).update({
      shares: firebase.firestore.FieldValue.increment(1)
    });
    post.shares = (post.shares || 0) + 1;
    await awardPointsForInteraction(currentUser?.uid, postId, 'sharing feed post');
    showToast('📤 Feed post shared! +10 points', true);
    renderMainApp();
    restoreScrollPosition();
  } catch (error) {
    console.error('Error sharing feed post:', error);
    showToast('Failed to share.', false);
  }
}

// ============================================================
// ===== SUBMIT WORD GAME ANSWER =====
// ============================================================

async function submitWordGameAnswer(gameId) {
  const input = document.getElementById(`wordGameInput_${gameId}`);
  if (!input) return;
  const answer = input.value.trim();
  if (!answer) {
    showToast('Please enter a word.', false);
    return;
  }
  const game = currentWordGames.find(g => g.id === gameId);
  if (!game) {
    showToast('Word game not found.', false);
    return;
  }
  const success = await submitWordAnswer(gameId, answer);
  if (success) {
    game.userSubmitted = true;
    renderMainApp();
    restoreScrollPosition();
  }
}


// ============================================================
// ===== VOTE ON POLL =====
// ============================================================

async function voteOnPoll(postId, optionIndex) {
  if (!currentUser) {
    showToast('Please sign in to vote', false);
    return;
  }
  
  const post = feedPosts.find(p => p.id === postId);
  if (!post) return;
  
  const userId = currentUser.uid;
  const voteKey = `poll_vote_${postId}`;
  const existingVote = localStorage.getItem(voteKey);
  
  try {
    const updateData = {};
    if (existingVote !== undefined && existingVote !== null) {
      updateData[`pollVotes.${existingVote}`] = firebase.firestore.FieldValue.increment(-1);
    }
    updateData[`pollVotes.${optionIndex}`] = firebase.firestore.FieldValue.increment(1);
    await db.collection('feed_posts').doc(postId).update(updateData);
    localStorage.setItem(voteKey, String(optionIndex));
    if (existingVote === undefined || existingVote === null) {
      await awardPointsForInteraction(userId, postId, 'voting on poll');
      showToast('🗳️ Vote cast! +10 points', true);
    }
    renderMainApp();
    restoreScrollPosition();
  } catch (error) {
    console.error('Error voting on poll:', error);
    showToast('Failed to vote.', false);
  }
}



function renderFeed() {
  if (feedPosts.length === 0) {
    return `
      <div class="feed-container">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem;">
          <h2 style="color:#fffffe;font-size:1.2rem;">📰 Feed</h2>
          <span style="color:#6b7280;font-size:0.8rem;">0 posts</span>
        </div>
        <div style="text-align:center;padding:2rem;color:#6b7280;">No feed posts yet. Check back later!</div>
      </div>
    `;
  }
  
  // Only show first 10 feed posts initially (feed posts are fewer)
  const initialPosts = feedPosts.slice(0, 10);
  const remainingPosts = feedPosts.slice(10);
  
  let feedWithAds = '';
  const postItems = initialPosts;
  
  if (postItems.length > 0 && approvedAds.length > 0) {
    for (let i = 0; i < postItems.length; i++) {
      feedWithAds += renderSingleFeedPost(postItems[i]);
      
      if ((i + 1) % 3 === 0 && i < postItems.length - 1) {
        const ad = getNextAd();
        if (ad && (ad.budgetLeft || 0) > 0) {
          feedWithAds += renderAdBanner(ad);
        }
      }
    }
    
    if (postItems.length > 0) {
      const ad = getNextAd();
      if (ad && (ad.budgetLeft || 0) > 0) {
        feedWithAds += renderAdBanner(ad);
      }
    }
  } else {
    feedWithAds = postItems.map(post => renderSingleFeedPost(post)).join('');
  }
  
  // Add "load more" for feed if there are more posts
  const hasMoreFeedPosts = remainingPosts.length > 0;
  const loadMoreHTML = `
    <div id="loadingMoreFeed" style="text-align:center;padding:1rem;color:#6b7280;display:none;">
      <div class="spinner" style="width:24px;height:24px;border:2px solid #2a2a4e;border-top-color:#e94560;border-radius:50%;animation:spin 1s linear infinite;margin:0 auto 8px;"></div>
      <p>Loading more posts...</p>
    </div>
    ${hasMoreFeedPosts ? `
      <button onclick="loadMoreFeedPosts()" id="loadMoreFeedBtn" style="width:100%;padding:0.8rem;background:#1a1a2e;border:1px solid #2a2a4e;border-radius:12px;color:#a7a9be;cursor:pointer;font-size:0.9rem;margin-top:0.5rem;">
        📥 Load More Feed Posts (${remainingPosts.length} remaining)
      </button>
    ` : `
      <div style="text-align:center;padding:1rem;color:#6b7280;">
        <p>— End of feed —</p>
      </div>
    `}
    <div id="feedScrollSentinel" style="height:10px;width:100%;"></div>
  `;
  
  return `
    <div class="feed-container">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem;">
        <h2 style="color:#fffffe;font-size:1.2rem;">📰 Feed</h2>
        <span style="color:#6b7280;font-size:0.8rem;">${feedPosts.length} posts</span>
      </div>
      <div id="feedPostsContainer">
        ${feedWithAds}
        ${loadMoreHTML}
      </div>
    </div>
  `;
}

// ============================================================
// ===== LOAD MORE FEED POSTS =====
// ============================================================

let feedBatchSize = 10;
let feedBatchIndex = 0;

// ============================================================
// ===== NOTIFICATION DETAIL =====
// ============================================================

function openNotificationDetail(notification) {
  selectedNotification = notification;
  showNotificationDetail = true;
  if (!notification.read) {
    markNotificationRead(notification.id);
  }
  
  if (notification.type === 'reply' && notification.commentId && notification.postId) {
    setTimeout(() => {
      showNotificationDetail = false;
      selectedNotification = null;
      openReplyView(notification);
    }, 100);
    return;
  }
  
  renderMainApp();
}

function closeNotificationDetail() {
  selectedNotification = null;
  showNotificationDetail = false;
  renderMainApp();
}

function renderNotificationDetail() {
  if (!selectedNotification) return '';
  
  const hasPost = selectedNotification.postId && selectedNotification.postId !== '';
  const hasComment = selectedNotification.commentId;
  const isReply = selectedNotification.type === 'reply';
  const isTag = selectedNotification.type === 'tag';
  
  let postPreview = '';
  if (hasPost) {
    const post = communityPosts.find(p => p.id === selectedNotification.postId);
    if (post) {
      postPreview = `
        <div style="background:#0f0e17;border-radius:12px;padding:0.8rem;margin:0.5rem 0 1rem 0;border-left:3px solid #e94560;">
          <div style="color:#6b7280;font-size:0.7rem;margin-bottom:0.3rem;">📄 Post Preview</div>
          <div style="color:#e5e7eb;font-size:0.9rem;word-wrap:break-word;white-space:pre-wrap;max-height:100px;overflow:hidden;text-overflow:ellipsis;">
            ${escapeHtml(post.content.substring(0, 200))}${post.content.length > 200 ? '...' : ''}
          </div>
          ${post.images && post.images.length > 0 ? `<div style="color:#6b7280;font-size:0.7rem;margin-top:0.3rem;">📷 ${post.images.length} image(s)</div>` : ''}
          <div style="color:#6b7280;font-size:0.7rem;margin-top:0.3rem;">❤️ ${post.likes} · 💬 ${post.comments}</div>
        </div>
      `;
    } else {
      postPreview = `
        <div style="background:#0f0e17;border-radius:12px;padding:0.8rem;margin:0.5rem 0 1rem 0;border-left:3px solid #ff9800;">
          <div style="color:#6b7280;font-size:0.8rem;">⚠️ Post may have been deleted or is no longer available.</div>
        </div>
      `;
    }
  }
  
  const seePostButton = hasPost ? `
    <button onclick="openFullPostViewFromNotification('${selectedNotification.postId}')" style="width:100%;padding:0.8rem;background:#e94560;border:none;border-radius:10px;color:white;font-weight:600;cursor:pointer;font-size:1rem;margin-top:0.5rem;display:flex;align-items:center;justify-content:center;gap:0.5rem;">
      📖 See Full Post
    </button>
  ` : '';
  
  const replyButton = isReply ? `
    <button onclick="openReplyViewFromNotification('${selectedNotification.id}')" style="width:100%;padding:0.8rem;background:#2a2a4e;border:none;border-radius:10px;color:#fffffe;font-weight:600;cursor:pointer;font-size:1rem;margin-top:0.5rem;display:flex;align-items:center;justify-content:center;gap:0.5rem;">
      💬 View & Reply
    </button>
  ` : '';
  
  return `
    <div class="notification-detail-screen" style="min-height:100vh;background:#0f0e17;display:flex;flex-direction:column;">
      <div class="notification-detail-header" style="display:flex;justify-content:space-between;align-items:center;padding:0.8rem 1rem;background:#1a1a2e;border-bottom:1px solid #2a2a4e;position:sticky;top:0;z-index:100;">
        <button class="back-btn" onclick="closeNotificationDetail()" style="background:none;border:none;color:#fffffe;font-size:1.5rem;cursor:pointer;">←</button>
        <span style="color:#fffffe;font-weight:600;">${isTag ? 'Tagged You' : isReply ? 'Reply' : 'Notification'}</span>
        <div style="width:40px;"></div>
      </div>
      <div class="notification-detail-body" style="flex:1;padding:1rem;overflow-y:auto;max-width:500px;margin:0 auto;width:100%;">
        <div style="background:#1a1a2e;border-radius:16px;padding:1.5rem;border:1px solid #2a2a4e;">
          <div style="display:flex;align-items:center;gap:0.8rem;margin-bottom:1rem;">
            <span style="font-size:2rem;">${isTag ? '🏷️' : isReply ? '💬' : selectedNotification.type === 'admin' ? '📢' : '📩'}</span>
            <div>
              <div style="color:#fffffe;font-weight:600;">${selectedNotification.fromName || 'DHouse'}</div>
              <div style="color:#6b7280;font-size:0.8rem;">${selectedNotification.time}</div>
            </div>
          </div>
          
          <div style="color:#e5e7eb;font-size:1.05rem;line-height:1.6;white-space:pre-wrap;margin-bottom:1rem;padding:0.5rem 0;border-top:1px solid #2a2a4e;border-bottom:1px solid #2a2a4e;">
            ${escapeHtml(selectedNotification.message)}
          </div>
          
          ${isTag ? `
            <div style="background:rgba(233,69,96,0.1);border-radius:8px;padding:0.5rem 1rem;margin-bottom:1rem;border:1px solid #e94560;">
              <div style="color:#FFB300;font-weight:600;font-size:0.9rem;">🏷️ You were tagged in a post</div>
            </div>
          ` : ''}
          
          ${postPreview}
          
          ${seePostButton}
          ${replyButton}
          
          ${!hasPost ? `
            <div style="color:#6b7280;font-size:0.85rem;text-align:center;padding:0.5rem;">
              This notification doesn't have an associated post.
            </div>
          ` : ''}
        </div>
      </div>
    </div>
  `;
}

function openFullPostViewFromNotification(postId) {
  if (!postId) {
    showToast('Post not found.', false);
    return;
  }
  showNotificationDetail = false;
  selectedNotification = null;
  openFullPostView(postId);
}

function openReplyViewFromNotification(notificationId) {
  const notification = getNotificationById(notificationId);
  if (notification) {
    showNotificationDetail = false;
    selectedNotification = null;
    openReplyView(notification);
  } else {
    showToast('Notification not found.', false);
  }
}

// ============================================================
// ===== REPLY VIEW =====
// ============================================================

function openReplyView(notification) {
  showReplyView = true;
  replyViewData = {
    postId: notification.postId,
    commentId: notification.commentId,
    parentCommentId: notification.parentCommentId,
    replyText: notification.replyText || '',
    fromName: notification.fromName || 'Someone',
    message: notification.message
  };
  renderReplyView();
}

function closeReplyView() {
  showReplyView = false;
  replyViewData = null;
  renderMainApp();
}

function renderReplyView() {
  if (!replyViewData) return;
  
  const { postId, commentId, parentCommentId, replyText, fromName, message } = replyViewData;
  const post = communityPosts.find(p => p.id === postId);
  
  let html = `
    <div class="reply-view-screen" style="min-height:100vh;background:#0f0e17;display:flex;flex-direction:column;">
      <div class="reply-view-header" style="display:flex;justify-content:space-between;align-items:center;padding:0.8rem 1rem;background:#1a1a2e;border-bottom:1px solid #2a2a4e;position:sticky;top:0;z-index:100;">
        <button class="back-btn" onclick="closeReplyView()" style="background:none;border:none;color:#fffffe;font-size:1.5rem;cursor:pointer;">←</button>
        <span style="color:#fffffe;font-weight:600;">Reply</span>
        <div style="width:40px;"></div>
      </div>
      <div class="reply-view-body" style="flex:1;padding:1rem;overflow-y:auto;max-width:500px;margin:0 auto;width:100%;">
  `;
  
  if (post) {
    html += `
      <div class="post-preview-card" onclick="openFullPostView('${post.id}')" style="cursor:pointer;background:#1a1a2e;border-radius:12px;padding:1rem;margin-bottom:1rem;border:1px solid #2a2a4e;">
        <div style="color:#e94560;font-size:0.7rem;font-weight:600;margin-bottom:4px;">📄 POST</div>
        <div style="color:#fffffe;font-size:0.9rem;">${escapeHtml(post.content.substring(0, 100))}${post.content.length > 100 ? '...' : ''}</div>
        ${post.images && post.images.length > 0 ? `<div style="color:#6b7280;font-size:0.7rem;margin-top:4px;">📷 ${post.images.length} image(s)</div>` : ''}
        <div style="color:#e94560;font-size:0.7rem;margin-top:4px;">View full post →</div>
      </div>
    `;
  }
  
  html += `
    <div style="background:#1a1a2e;border-radius:12px;padding:1rem;border:1px solid #2a2a4e;margin-bottom:1rem;">
      <div style="color:#a7a9be;font-size:0.8rem;margin-bottom:4px;">${fromName} replied:</div>
      <div style="color:#e5e7eb;font-size:0.95rem;line-height:1.5;">${escapeHtml(replyText || message)}</div>
    </div>
  `;
  
  html += `
    <div style="background:#1a1a2e;border-radius:12px;padding:1rem;border:1px solid #2a2a4e;">
      <div style="display:flex;gap:8px;align-items:center;">
        <textarea id="replyViewInput" placeholder="Write a reply..." style="flex:1;padding:0.6rem 1rem;background:#0f0e17;border:1px solid #2a2a4e;border-radius:12px;color:#fffffe;font-size:0.9rem;outline:none;resize:vertical;min-height:40px;max-height:120px;font-family:inherit;line-height:1.4;"></textarea>
        <button onclick="submitReplyView()" style="padding:0.6rem 1.2rem;background:#e94560;border:none;border-radius:12px;color:white;font-weight:600;cursor:pointer;font-size:0.9rem;flex-shrink:0;">Reply</button>
      </div>
    </div>
  `;
  
  html += `
      </div>
    </div>
  `;
  
  root.innerHTML = html;
  
  const textarea = document.getElementById('replyViewInput');
  if (textarea) {
    textarea.addEventListener('input', function() {
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 120) + 'px';
    });
    setTimeout(() => textarea.focus(), 300);
  }
}

async function submitReplyView() {
  const input = document.getElementById('replyViewInput');
  const text = input.value.trim();
  if (!text) return;
  if (!replyViewData) return;
  
  const { postId, commentId, parentCommentId, fromName } = replyViewData;
  
  const submitBtn = input.nextElementSibling;
  submitBtn.disabled = true;
  submitBtn.textContent = '...';
  
  try {
    const user = currentUser;
    const userId = user?.uid || 'unknown';
    const username = user?.displayName || 'Anonymous';
    
    const collectionPath = `community_posts/${postId}/comments`;
    
    const replyText = `@${fromName} ${text}`;
    
    const commentData = {
      username: username,
      text: replyText,
      timestamp: firebase.firestore.FieldValue.serverTimestamp(),
      userId: userId,
      parentId: commentId || parentCommentId || null
    };
    
    let parentAuthorId = null;
    let parentUsername = '';
    let targetCommentId = commentId || parentCommentId;
    
    if (targetCommentId) {
      try {
        const parentDoc = await db.collection(collectionPath).doc(targetCommentId).get();
        if (parentDoc.exists) {
          const parentData = parentDoc.data();
          parentAuthorId = parentData.userId;
          parentUsername = parentData.username || 'someone';
        }
      } catch (e) {
        console.error('Error getting parent comment:', e);
      }
    }
    
    const newCommentRef = await db.collection(collectionPath).add(commentData);
    
    if (parentAuthorId && parentAuthorId !== userId && parentAuthorId !== 'unknown') {
      await db.collection('notifications').add({
        type: 'reply',
        from: userId,
        fromName: username,
        to: parentAuthorId,
        message: `@${username} replied to @${parentUsername}: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`,
        read: false,
        time: 'Just now',
        timestamp: firebase.firestore.FieldValue.serverTimestamp(),
        postId: postId,
        commentId: newCommentRef.id,
        parentCommentId: targetCommentId || '',
        replyText: text      });
    }
    
    const postRef = db.collection('community_posts').doc(postId);
    await postRef.update({
      commentCount: firebase.firestore.FieldValue.increment(1)
    });
    
    const localPost = communityPosts.find(p => p.id === postId);
    if (localPost) {
      localPost.comments = (localPost.comments || 0) + 1;
      localPost.commentCount = (localPost.commentCount || 0) + 1;
    }
    
    if (userId !== 'unknown') {
      await awardPointsForInteraction(userId, postId, 'replying');
    }
    
    input.value = '';
    input.style.height = 'auto';
    showToast('✅ Reply posted! +10 points', true);
    
    setTimeout(() => {
      closeReplyView();
    }, 500);
    
  } catch (error) {
    console.error('Error submitting reply:', error);
    showToast('❌ Failed to post reply.', false);
  }
  
  submitBtn.disabled = false;
  submitBtn.textContent = 'Reply';
}

// ============================================================
// ===== FULL POST VIEW =====
// ============================================================

function openFullPostView(postId) {
  const post = communityPosts.find(p => p.id === postId);
  if (!post) {
    showToast('Post not found.', false);
    return;
  }
  fullPostData = post;
  fullPostId = postId;
  showFullPostView = true;
  renderFullPostView();
}

function closeFullPostView() {
  showFullPostView = false;
  fullPostData = null;
  fullPostId = null;
  renderMainApp();
}

function renderFullPostView() {
  if (!fullPostData) return;
  
  const post = fullPostData;
  const isOwnPost = post.userId === currentUser?.uid;
  const isUserFlagged = userFlaggedPosts.has(post.id);
  const flagText = isUserFlagged ? '✅ Unflag' : '🚩 Flag';
  
  let imagesHTML = '';
  if (post.images && post.images.length > 0) {
    const imageCount = post.images.length;
    if (imageCount === 1) {
      imagesHTML = `
        <div class="post-image-single" onclick="openImageViewer(getPostById('${post.id}'))">
          <img src="${getOptimizedImageUrl(post.images[0], 800)}" alt="Post image" style="width:100%;max-height:500px;object-fit:contain;display:block;border-radius:12px;background:#0f0e17;cursor:pointer;">
        </div>
      `;
    } else {
      imagesHTML = `<div style="display:grid;grid-template-columns:repeat(${Math.min(imageCount, 3)},1fr);gap:4px;margin-top:8px;">`;
      for (let i = 0; i < Math.min(imageCount, 6); i++) {
        imagesHTML += `
          <div style="aspect-ratio:1;overflow:hidden;border-radius:8px;cursor:pointer;" onclick="openImageViewer(getPostById('${post.id}'))">
            <img src="${getOptimizedImageUrl(post.images[i], 400)}" style="width:100%;height:100%;object-fit:cover;">
          </div>
        `;
      }
      if (imageCount > 6) {
        imagesHTML += `
          <div style="aspect-ratio:1;border-radius:8px;background:#2a2a4e;display:flex;align-items:center;justify-content:center;color:#6b7280;font-size:0.9rem;cursor:pointer;" onclick="openImageViewer(getPostById('${post.id}'))">
            +${imageCount - 6}
          </div>
        `;
      }
      imagesHTML += `</div>`;
    }
  }
  
  const emojiReactions = post.emojiReactions || {};
  let emojiBadgesHtml = '';
  for (const [emoji, data] of Object.entries(emojiReactions)) {
    if (data.count > 0) {
      const userReacted = postEmojiReactions[`emoji_${post.id}_${currentUser?.uid}`] === emoji;
      emojiBadgesHtml += `
        <div class="emoji-reaction-badge ${userReacted ? 'active' : ''}" onclick="addEmojiReaction('${post.id}', '${emoji}')">
          <span class="emoji-reaction-emoji">${emoji}</span>
          <span class="emoji-reaction-count">${data.count}</span>
        </div>
      `;
    }
  }
  
  const addReactionHtml = `
    <button class="add-reaction-btn" onclick="showEmojiPicker('${post.id}', event)" style="background:#2a2a4e;border:none;color:#a7a9be;padding:2px 10px;border-radius:12px;font-size:0.8rem;cursor:pointer;display:inline-flex;align-items:center;gap:4px;">
      😊 <span style="font-size:0.6rem;">react</span>
    </button>
  `;
  
  const html = `
    <div class="full-post-view" style="min-height:100vh;background:#0f0e17;">
      <div class="full-post-header" style="display:flex;justify-content:space-between;align-items:center;padding:0.8rem 1rem;background:#1a1a2e;border-bottom:1px solid #2a2a4e;position:sticky;top:0;z-index:100;">
        <button class="back-btn" onclick="closeFullPostView()" style="background:none;border:none;color:#fffffe;font-size:1.5rem;cursor:pointer;">←</button>
        <span style="color:#fffffe;font-weight:600;">Post</span>
        <div class="post-menu" style="position:relative;">
          <button class="icon-btn" onclick="togglePostMenu(event, '${post.id}')" style="font-size:1.2rem;background:none;border:none;color:#a7a9be;cursor:pointer;">⋮</button>
          <div id="postMenu_${post.id}" class="post-dropdown" style="display:none;position:absolute;right:0;top:100%;background:#1a1a2e;border:1px solid #2a2a4e;border-radius:12px;padding:0.3rem 0;min-width:150px;z-index:50;box-shadow:0 4px 20px rgba(0,0,0,0.5);">
            <button class="flag ${isUserFlagged ? 'flagged' : ''}" onclick="toggleFlagPost('${post.id}', event)" style="display:block;width:100%;padding:0.5rem 1rem;background:none;border:none;color:${isUserFlagged ? '#4CAF50' : '#ff9800'};text-align:left;cursor:pointer;font-size:0.85rem;font-family:inherit;">${flagText}</button>
            ${(isOwnPost || isAdmin) ? `<button class="delete" onclick="deleteUserPost('${post.id}', event)" style="display:block;width:100%;padding:0.5rem 1rem;background:none;border:none;color:#e94560;text-align:left;cursor:pointer;font-size:0.85rem;font-family:inherit;">🗑️ Delete</button>` : ''}
          </div>
        </div>
      </div>
      <div class="full-post-body" style="padding:1rem;max-width:500px;margin:0 auto;">
        <div class="post-user" style="display:flex;align-items:center;gap:0.7rem;margin-bottom:0.5rem;">
          <div class="avatar">${getUserAvatarSmall(post.user, null)}</div>
          <div>
            <div class="post-username" style="font-weight:600;color:#fffffe;">${post.user}</div>
            <div class="post-handle" style="font-size:0.8rem;color:#6b7280;">${post.username || '@user'} · ${post.time}</div>
          </div>
        </div>
        <div class="post-content" style="word-wrap:break-word;overflow-wrap:break-word;font-size:1.05rem;line-height:1.6;color:#e5e7eb;">
          ${escapeHtml(post.content)}
        </div>
        ${post.tags && post.tags.length > 0 ? `<div style="color:#e94560;font-size:0.8rem;margin-bottom:0.5rem;">@${post.tags.join(', @')}</div>` : ''}
        ${imagesHTML}
        ${emojiBadgesHtml ? `<div class="post-emoji-reactions" style="display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;padding-top:8px;border-top:1px solid #2a2a4e;">${emojiBadgesHtml} ${addReactionHtml}</div>` : `<div style="margin-top:8px;padding-top:8px;border-top:1px solid #2a2a4e;">${addReactionHtml}</div>`}
        <div class="post-actions" style="margin-top:12px;padding-top:12px;border-top:1px solid #2a2a4e;display:flex;gap:1.5rem;">
          <button class="action-btn" onclick="likeCommunityPost('${post.id}', event)">❤️ ${post.likes}</button>
          <button class="action-btn" onclick="commentPost('${post.id}', true)">💬 ${post.comments}</button>
          <button class="action-btn" onclick="sharePost('${post.id}', true)">↗️ ${post.shares || 0}</button>
        </div>
      </div>
    </div>
  `;
  
  root.innerHTML = html;
}

// ============================================================
// ===== VIEWER SCREENS =====
// ============================================================

function openImageViewer(post) {
  viewerType = 'image';
  viewerPost = post;
  viewerImages = post.images || [];
  viewerImageIndex = 0;
  renderViewer();
}

function openGalleryViewer(post) {
  viewerType = 'gallery';
  viewerPost = post;
  viewerImages = post.images || [];
  viewerImageIndex = 0;
  renderViewer();
}

function closeViewer() {
  viewerType = null;
  viewerPost = null;
  viewerImages = [];
  viewerImageIndex = 0;
  if (showFullPostView) {
    renderFullPostView();
  } else if (showReplyView) {
    renderReplyView();
  } else {
    renderMainApp();
  }
}

function renderViewer() {
  if (viewerType === 'image' && viewerPost && viewerImages.length > 0) {
    const image = viewerImages[0];
    root.innerHTML = `
      <div class="viewer-overlay" onclick="closeViewer()" style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.95);z-index:1000;display:flex;align-items:center;justify-content:center;">
        <button class="viewer-close" onclick="closeViewer()" style="position:fixed;top:1rem;right:1rem;background:none;border:none;color:white;font-size:2rem;cursor:pointer;z-index:1001;">✕</button>
        <div class="viewer-content" onclick="event.stopPropagation()" style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;">
          <div class="viewer-image-container-full" style="width:100%;height:80vh;display:flex;align-items:center;justify-content:center;overflow:hidden;">
            <img src="${getOptimizedImageUrl(image, 1200)}" alt="Post image" class="viewer-image-full" style="max-width:100%;max-height:80vh;object-fit:contain;">
          </div>
        </div>
      </div>
    `;
    return;
  }

  if (viewerType === 'gallery' && viewerPost && viewerImages.length > 0) {
    let imagesHTML = viewerImages.map((image) => `
      <div class="gallery-item-wrapper" style="margin-bottom:2rem;border-radius:16px;overflow:hidden;background:rgba(0,0,0,0.6);">
        <div class="gallery-image-container" style="width:100%;display:flex;align-items:center;justify-content:center;overflow:hidden;">
          <img src="${getOptimizedImageUrl(image, 1200)}" alt="Gallery image" class="gallery-image-full" style="width:100%;max-height:80vh;object-fit:contain;">
        </div>
      </div>
    `).join('');
    
    root.innerHTML = `
      <div class="viewer-overlay gallery-overlay" onclick="closeViewer()" style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.95);z-index:1000;overflow-y:auto;padding:1rem;">
        <button class="viewer-close" onclick="closeViewer()" style="position:fixed;top:1rem;right:1rem;background:none;border:none;color:white;font-size:2rem;cursor:pointer;z-index:1001;">✕</button>
        <div class="gallery-scroll-container" onclick="event.stopPropagation()" style="max-width:800px;margin:0 auto;padding-top:4rem;padding-bottom:4rem;">
          ${imagesHTML}
        </div>
      </div>
    `;
    return;
  }

  closeViewer();
}

// ============================================================
// ===== COMMUNITY FUNCTIONS =====
// ============================================================

function renderSingleCommunityPost(post) {
  const isExpanded = expandedPosts[post.id] || false;
  const fullText = post.content || '';
  const needsTruncation = fullText.length > 200;
  const displayContent = fullText;
  
  const isOwnPost = post.userId === currentUser?.uid;
  const isUserFlagged = userFlaggedPosts.has(post.id);
  
  let imagesHTML = '';
  if (post.images && post.images.length > 0) {
    const imageCount = post.images.length;
    if (imageCount === 1) {
      imagesHTML = `
        <div class="post-image-single" onclick="openImageViewer(getPostById('${post.id}'))">
          <img data-src="${getOptimizedImageUrl(post.images[0], 600)}" alt="Post image" class="lazy-image" style="width:100%;max-height:400px;object-fit:cover;display:block;border-radius:12px;background:#1a1a2e;opacity:0;transition:opacity 0.3s ease;">
        </div>
      `;
    } else {
      let gridClass = 'post-image-grid';
      if (imageCount === 2) gridClass += ' grid-2';
      else if (imageCount === 3) gridClass += ' grid-3';
      else if (imageCount >= 4) gridClass += ' grid-4';
      else gridClass += ' grid-many';
      
      const displayImages = post.images.slice(0, 4);
      const extraCount = imageCount - 4;
      
      imagesHTML = `
        <div class="${gridClass}" onclick="openGalleryViewer(getPostById('${post.id}'))">
          ${displayImages.map((img, i) => `
            <div class="grid-item">
              <img data-src="${getOptimizedImageUrl(img, 400)}" alt="Post image ${i + 1}" class="lazy-image" style="width:100%;height:100%;object-fit:cover;background:#0f0e17;opacity:0;transition:opacity 0.3s ease;">
              ${i === 3 && extraCount > 0 ? `<div class="grid-overlay">+${extraCount}</div>` : ''}
            </div>
          `).join('')}
        </div>
      `;
    }
  }
  
  const emojiReactions = post.emojiReactions || {};
  let emojiBadgesHtml = '';
  for (const [emoji, data] of Object.entries(emojiReactions)) {
    if (data.count > 0) {
      const userReacted = postEmojiReactions[`emoji_${post.id}_${currentUser?.uid}`] === emoji;
      emojiBadgesHtml += `
        <div class="emoji-reaction-badge ${userReacted ? 'active' : ''}" onclick="addEmojiReaction('${post.id}', '${emoji}')">
          <span class="emoji-reaction-emoji">${emoji}</span>
          <span class="emoji-reaction-count">${data.count}</span>
        </div>
      `;
    }
  }
  
  const addReactionHtml = `
    <button class="add-reaction-btn" onclick="showEmojiPicker('${post.id}', event)" style="background:#2a2a4e;border:none;color:#a7a9be;padding:2px 10px;border-radius:12px;font-size:0.8rem;cursor:pointer;display:inline-flex;align-items:center;gap:4px;">
      😊 <span style="font-size:0.6rem;">react</span>
    </button>
  `;
  
  const flagText = isUserFlagged ? '✅ Unflag' : '🚩 Flag';
  const menuHtml = `
    <div class="post-menu">
      <button class="icon-btn" onclick="togglePostMenu(event, '${post.id}')" style="font-size:1.2rem;background:none;border:none;color:#a7a9be;cursor:pointer;">⋮</button>
      <div id="postMenu_${post.id}" class="post-dropdown">
        <button class="flag ${isUserFlagged ? 'flagged' : ''}" onclick="toggleFlagPost('${post.id}', event)">${flagText}</button>
        ${(isOwnPost || isAdmin) ? `<button class="delete" onclick="deleteUserPost('${post.id}', event)">🗑️ Delete</button>` : ''}
      </div>
    </div>
  `;
  
  return `
    <div class="post-card" id="post-${post.id}" data-post-id="${post.id}" style="width:100%;position:relative;contain:content;">
      <div class="post-header">
        <div class="post-user">
          <div class="avatar">${getUserAvatarSmall(post.user, null)}</div>
          <div>
            <div class="post-username">${post.user}</div>
            <div class="post-handle">${post.username || '@user'} · ${post.time}</div>
          </div>
        </div>
        ${menuHtml}
      </div>
      <div class="post-content" style="word-wrap:break-word;overflow-wrap:break-word;">
        <div class="post-text ${needsTruncation && !isExpanded ? 'truncated' : 'expanded-text'}" style="white-space:pre-wrap;word-wrap:break-word;overflow-wrap:break-word;${needsTruncation && !isExpanded ? 'display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;' : ''}">
          ${escapeHtml(displayContent)}
        </div>
        ${needsTruncation ? `<span class="see-more" onclick="togglePostExpand('${post.id}')"> ${isExpanded ? 'See less' : 'See more'}</span>` : ''}
      </div>
      ${post.tags && post.tags.length > 0 ? `<div style="color:#e94560;font-size:0.8rem;margin-bottom:0.5rem;">@${post.tags.join(', @')}</div>` : ''}
      ${imagesHTML}
      ${emojiBadgesHtml ? `<div class="post-emoji-reactions">${emojiBadgesHtml} ${addReactionHtml}</div>` : `<div class="post-emoji-reactions">${addReactionHtml}</div>`}
      <div class="post-actions">
        <button class="action-btn" onclick="likeCommunityPost('${post.id}', event)">❤️ ${post.likes}</button>
        <button class="action-btn" onclick="commentPost('${post.id}', true)">💬 ${post.comments}</button>
        <button class="action-btn" onclick="sharePost('${post.id}', true)">↗️ ${post.shares || 0}</button>
      </div>
    </div>
  `;
}

function renderCommunity() {
  if (!isDataLoaded) {
    return `<div style="text-align:center;padding:2rem;color:#6b7280;">Loading community posts...</div>`;
  }
  
  if (showSearchScreen) {
    return renderSearchScreen();
  }
  
  // 🔀 SHUFFLE POSTS FOR RANDOM ORDER
  let sortedPosts = [...communityPosts];
  
  // Shuffle the array (Fisher-Yates)
  for (let i = sortedPosts.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [sortedPosts[i], sortedPosts[j]] = [sortedPosts[j], sortedPosts[i]];
  }
  
  // Only show first batch initially
  const initialPosts = sortedPosts.slice(0, postBatchSize);
  const remainingPosts = sortedPosts.slice(postBatchSize);
  
  // If we have more posts, set hasMorePosts to true
  hasMorePosts = remainingPosts.length > 0;
  
  if (sortedPosts.length === 0) {
    return `
      <div class="community-container">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem;">
          <h2 style="color:#fffffe;font-size:1.2rem;">👥 Community Feed</h2>
          <div style="display:flex;gap:0.5rem;">
            <button onclick="sortCommunity('newest')" style="background:${communitySortMode === 'newest' ? '#e94560' : '#2a2a4e'};border:none;color:white;padding:0.3rem 0.8rem;border-radius:12px;font-size:0.7rem;cursor:pointer;">Newest</button>
            <button onclick="sortCommunity('random')" style="background:${communitySortMode === 'random' ? '#e94560' : '#2a2a4e'};border:none;color:white;padding:0.3rem 0.8rem;border-radius:12px;font-size:0.7rem;cursor:pointer;">Random</button>
          </div>
        </div>
        <div style="text-align:center;padding:2rem;color:#6b7280;">
          <p style="font-size:1.5rem;margin-bottom:0.5rem;">📝</p>
          <p>No posts yet. Be the first to share!</p>
        </div>
      </div>
    `;
  }
  
  let communityWithAds = '';
  const postItems = initialPosts;
  
  if (postItems.length > 0 && approvedAds.length > 0) {
    for (let i = 0; i < postItems.length; i++) {
      communityWithAds += renderSingleCommunityPost(postItems[i]);
      
      if ((i + 1) % 3 === 0 && i < postItems.length - 1) {
        const ad = getNextAd();
        if (ad && (ad.budgetLeft || 0) > 0) {
          communityWithAds += renderAdBanner(ad);
        }
      }
    }
    
    if (postItems.length > 0) {
      const ad = getNextAd();
      if (ad && (ad.budgetLeft || 0) > 0) {
        communityWithAds += renderAdBanner(ad);
      }
    }
  } else {
    communityWithAds = postItems.map(post => renderSingleCommunityPost(post)).join('');
  }
  
  // Add loading sentinel and "load more" UI
  const loadMoreHTML = `
    <div id="loadingMoreCommunity" style="text-align:center;padding:1rem;color:#6b7280;display:none;">
      <div class="spinner" style="width:24px;height:24px;border:2px solid #2a2a4e;border-top-color:#e94560;border-radius:50%;animation:spin 1s linear infinite;margin:0 auto 8px;"></div>
      <p>Loading more posts...</p>
    </div>
    ${hasMorePosts ? `
      <button onclick="loadMoreCommunityPosts()" id="loadMoreCommunityBtn" style="width:100%;padding:0.8rem;background:#1a1a2e;border:1px solid #2a2a4e;border-radius:12px;color:#a7a9be;cursor:pointer;font-size:0.9rem;margin-top:0.5rem;">
        📥 Load More Posts (${remainingPosts.length} remaining)
      </button>
    ` : `
      <div id="endOfPosts" style="text-align:center;padding:1rem;color:#6b7280;display:block;">
        <p>— You've seen all posts —</p>
      </div>
    `}
    <div id="scrollSentinel" style="height:10px;width:100%;"></div>
  `;
  
  return `
    <div class="community-container">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem;">
        <h2 style="color:#fffffe;font-size:1.2rem;">👥 Community Feed</h2>
        <div style="display:flex;gap:0.5rem;">
          <button onclick="sortCommunity('newest')" style="background:${communitySortMode === 'newest' ? '#e94560' : '#2a2a4e'};border:none;color:white;padding:0.3rem 0.8rem;border-radius:12px;font-size:0.7rem;cursor:pointer;">Newest</button>
          <button onclick="sortCommunity('random')" style="background:${communitySortMode === 'random' ? '#e94560' : '#2a2a4e'};border:none;color:white;padding:0.3rem 0.8rem;border-radius:12px;font-size:0.7rem;cursor:pointer;">🎲 Random</button>
        </div>
      </div>
      
      <div style="text-align:center;color:#6b7280;font-size:0.8rem;margin-bottom:0.5rem;">
        ${sortedPosts.length} posts in community • ⭐ ${POINTS_PER_INTERACTION} points per interaction
        ${communitySortMode === 'random' ? ' 🔀 Showing in random order' : ''}
      </div>
      
      <div id="communityPostsContainer">
        ${communityWithAds}
        ${loadMoreHTML}
      </div>
    </div>
  `;
}

// ============================================================
// ===== COMMUNITY POST LIKE =====
// ============================================================

async function likeCommunityPost(postId, event) {
  if (event) {
    event.stopPropagation();
    event.preventDefault();
  }
  const post = communityPosts.find(p => p.id === postId);
  if (!post) {
    showToast('Post not found.', false);
    return;
  }
  const userId = currentUser?.uid;
  if (!userId) {
    showToast('Please sign in to like', false);
    return;
  }
  
  const likeKey = `comm_like_${postId}`;
  if (pendingLikes.has(likeKey)) return;
  pendingLikes.add(likeKey);
  
  const newLiked = !post.liked;
  const increment = newLiked ? 1 : -1;
  
  try {
    post.liked = newLiked;
    post.likes = Math.max(0, (post.likes || 0) + (newLiked ? 1 : -1));
    
    await db.collection('community_posts').doc(postId).update({
      likes: firebase.firestore.FieldValue.increment(increment),
      liked: newLiked
    });
    
    if (newLiked) {
      await awardPointsForInteraction(userId, postId, 'liking a community post');
      logEvent('post_liked', {
        post_id: postId,
        type: 'community'
      });
      showToast('❤️ Liked! +10 points', true);
    } else {
      await removePointsForInteraction(userId, postId);
      showToast('❤️ Unliked! -10 points', true);
    }
    
    if (userId === currentUser?.uid) {
      currentUserPoints = newLiked ? currentUserPoints + 10 : Math.max(0, currentUserPoints - 10);
    }
    
    renderMainApp();
    restoreScrollPosition();
  } catch (error) {
    console.error('Error liking community post:', error);
    post.liked = !newLiked;
    post.likes = Math.max(0, (post.likes || 0) - (newLiked ? 1 : -1));
    showToast('Failed to like. Please try again.', false);
    
    if (typeof Sentry !== 'undefined') {
      Sentry.captureException(error, {
        tags: {
          operation: 'likeCommunityPost',
          postId: postId,
          userId: userId,
          newLiked: newLiked,
        },
        extra: {
          postId: postId,
          userId: userId,
          newLiked: newLiked,
          errorMessage: error.message,
        },
      });
    }
  }
  pendingLikes.delete(likeKey);
}

function togglePostMenu(event, postId) {
  event.stopPropagation();
  const menu = document.getElementById(`postMenu_${postId}`);
  if (menu) {
    document.querySelectorAll('.post-dropdown').forEach(m => {
      if (m.id !== `postMenu_${postId}`) m.classList.remove('show');
    });
    menu.classList.toggle('show');
  }
}

document.addEventListener('click', function() {
  document.querySelectorAll('.post-dropdown').forEach(m => m.classList.remove('show'));
});

function sortCommunity(mode) {
  communitySortMode = mode;
  
  if (mode === 'random') {
    // Shuffle the posts
    for (let i = communityPosts.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [communityPosts[i], communityPosts[j]] = [communityPosts[j], communityPosts[i]];
    }
  }
  
  renderMainApp();
  restoreScrollPosition();
}

// ============================================================
// ===== FEED POST LIKE =====
// ============================================================

async function likeFeedPost(postId) {
  const post = feedPosts.find(p => p.id === postId);
  if (!post) return;
  const userId = currentUser?.uid;
  
  const likeKey = `feed_like_${postId}`;
  if (pendingLikes.has(likeKey)) return;
  pendingLikes.add(likeKey);
  
  const newLiked = !post.liked;
  const increment = newLiked ? 1 : -1;
  
  try {
    post.liked = newLiked;
    post.likes = (post.likes || 0) + (newLiked ? 1 : -1);
    
    await db.collection('feed_posts').doc(postId).update({
      likes: firebase.firestore.FieldValue.increment(increment),
      liked: newLiked
    });
    
    if (newLiked) {
      await awardPointsForInteraction(userId, postId, 'liking feed post');
      logEvent('post_liked', {
        post_id: postId,
        type: 'feed'
      });
      showToast('❤️ Liked! +10 points', true);
    } else {
      await removePointsForInteraction(userId, postId);
      showToast('❤️ Unliked! -10 points', true);
    }
    
    if (userId === currentUser?.uid) {
      currentUserPoints = newLiked ? currentUserPoints + 10 : Math.max(0, currentUserPoints - 10);
    }
    
    renderMainApp();
    restoreScrollPosition();
  } catch (error) {
    console.error('Error liking feed post:', error);
    post.liked = !newLiked;
    post.likes = (post.likes || 0) - (newLiked ? 1 : -1);
    showToast('Failed to like. Please try again.', false);
  }
  pendingLikes.delete(likeKey);
}


// ============================================================
// ===== PREDICTIONS (User View) =====
// ============================================================

function renderPredictions() {
  if (predictions.length === 0) {
    return `
      <div class="predictions-container" style="padding:1rem;">
        <h2 style="color:#fffffe;margin-bottom:1rem;">🏆 Predictions</h2>
        <div style="background:#1a1a2e;border-radius:16px;padding:2rem;text-align:center;border:1px solid #2a2a4e;">
          <p style="font-size:2rem;margin-bottom:0.5rem;">🔮</p>
          <p style="color:#6b7280;">No predictions available yet. Check back later!</p>
        </div>
      </div>
    `;
  }
  
  const now = new Date();
  let predictionsHTML = predictions.map(pred => {
    const endsAtDate = pred.endsAt?.toDate ? pred.endsAt.toDate() : new Date(pred.endsAt);
    const isActive = endsAtDate > now && pred.correctAnswer === null;
    const userVote = userPredictions[pred.id] || null;
    const hasVoted = userVote !== null;
    const isEnded = !isActive || pred.correctAnswer !== null;
    
    let statusBadge = '';
    let votingOptions = '';
    let resultDisplay = '';
    
    if (isActive && !hasVoted) {
      statusBadge = `<span style="background:#4CAF50;padding:0.1rem 0.6rem;border-radius:12px;font-size:0.7rem;color:white;">🔴 Voting Open</span>`;
      
      votingOptions = `
        <div style="margin:0.8rem 0;">
          <label style="color:#a7a9be;font-size:0.8rem;display:block;margin-bottom:0.3rem;">Select your prediction:</label>
          <select id="pred_select_${pred.id}" style="width:100%;padding:0.6rem;background:#0f0e17;border:1px solid #2a2a4e;border-radius:10px;color:#fffffe;font-size:0.9rem;">
            <option value="">— Choose an option —</option>
            ${pred.options.map(opt => `<option value="${opt}">${opt}</option>`).join('')}
          </select>
          <button onclick="submitPrediction('${pred.id}')" style="width:100%;margin-top:0.5rem;padding:0.6rem;background:#e94560;border:none;border-radius:10px;color:white;font-weight:600;cursor:pointer;">🔮 Submit Prediction</button>
        </div>
      `;
    } else if (isActive && hasVoted) {
      statusBadge = `<span style="background:#FFB300;padding:0.1rem 0.6rem;border-radius:12px;font-size:0.7rem;color:#0f0e17;">⏳ Awaiting Results</span>`;
      votingOptions = `
        <div style="margin:0.8rem 0;padding:0.8rem;background:#0f0e17;border-radius:10px;text-align:center;">
          <div style="color:#FFB300;font-size:1rem;">✅ You voted: <strong>${userVote.selectedOption}</strong></div>
          <div style="color:#6b7280;font-size:0.8rem;margin-top:0.3rem;">⏳ Waiting for results...</div>
        </div>
      `;
    } else if (isEnded) {
      if (pred.correctAnswer) {
        const isCorrect = hasVoted && userVote.selectedOption === pred.correctAnswer;
        if (hasVoted && isCorrect) {
          statusBadge = `<span style="background:#4CAF50;padding:0.1rem 0.6rem;border-radius:12px;font-size:0.7rem;color:white;">🎉 Correct! +${pred.pointsValue || 100} pts</span>`;
        } else if (hasVoted && !isCorrect) {
          statusBadge = `<span style="background:#e94560;padding:0.1rem 0.6rem;border-radius:12px;font-size:0.7rem;color:white;">❌ Wrong</span>`;
        } else {
          statusBadge = `<span style="background:#6b7280;padding:0.1rem 0.6rem;border-radius:12px;font-size:0.7rem;color:white;">📊 Ended</span>`;
        }
      } else {
        statusBadge = `<span style="background:#FF9800;padding:0.1rem 0.6rem;border-radius:12px;font-size:0.7rem;color:white;">⏳ Results Pending</span>`;
      }
      
      if (pred.correctAnswer) {
        resultDisplay = `
          <div style="margin-top:0.5rem;padding:0.5rem;background:#0f0e17;border-radius:8px;">
            <div style="color:#a7a9be;font-size:0.8rem;">✅ Correct Answer: <strong style="color:#FFB300;">${pred.correctAnswer}</strong></div>
            ${hasVoted ? `<div style="color:${userVote.selectedOption === pred.correctAnswer ? '#4CAF50' : '#e94560'};font-size:0.8rem;">Your vote: ${userVote.selectedOption}</div>` : '<div style="color:#6b7280;font-size:0.8rem;">You did not vote on this prediction.</div>'}
          </div>
        `;
      } else if (hasVoted) {
        resultDisplay = `
          <div style="margin-top:0.5rem;padding:0.5rem;background:#0f0e17;border-radius:8px;">
            <div style="color:#6b7280;font-size:0.8rem;text-align:center;">⏳ Admin is reviewing the results...</div>
            <div style="color:#FFB300;font-size:0.8rem;text-align:center;">Your vote: ${userVote.selectedOption}</div>
          </div>
        `;
      } else {
        resultDisplay = `
          <div style="margin-top:0.5rem;padding:0.5rem;background:#0f0e17;border-radius:8px;">
            <div style="color:#6b7280;font-size:0.8rem;text-align:center;">⏳ Waiting for admin to set the correct answer...</div>
          </div>
        `;
      }
    }
    
    const endsAtStr = endsAtDate.toLocaleString();
    const timeLeft = isActive ? getTimeLeft(endsAtDate) : '';
    
    return `
      <div style="background:#1a1a2e;border-radius:16px;padding:1rem;margin-bottom:1rem;border:1px solid #2a2a4e;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;">
          <div style="flex:1;">
            <div style="color:#fffffe;font-weight:600;font-size:1.05rem;">${escapeHtml(pred.text)}</div>
            <div style="color:#6b7280;font-size:0.75rem;margin-top:0.2rem;">
              ⏳ Ends: ${endsAtStr} ${timeLeft ? `• ${timeLeft}` : ''}
              <span style="margin-left:0.5rem;">${statusBadge}</span>
            </div>
          </div>
          <div style="color:#FFB300;font-size:0.7rem;background:#2a2a4e;padding:0.1rem 0.6rem;border-radius:12px;">+${pred.pointsValue || 100} pts</div>
        </div>
        
        ${votingOptions}
        ${resultDisplay}
      </div>
    `;
  }).join('');
  
  return `
    <div class="predictions-container" style="padding:1rem;">
      <h2 style="color:#fffffe;margin-bottom:1rem;">🏆 Predictions</h2>
      ${predictionsHTML}
    </div>
  `;
}

// ============================================================
// ===== HOUSEMATES (User View) =====
// ============================================================

function renderHousemates() {
  if (showHousemateDetail && selectedHousemate) {
    renderHousemateDetail();
    return;
  }
  
  if (housemates.length === 0) {
    return `
      <div class="housemates-container" style="padding:1rem;">
        <h2 style="color:#fffffe;margin-bottom:1rem;">🏠 Housemates</h2>
        <div style="background:#1a1a2e;border-radius:16px;padding:2rem;text-align:center;border:1px solid #2a2a4e;">
          <p style="font-size:2rem;margin-bottom:0.5rem;">🏠</p>
          <p style="color:#6b7280;">No housemates added yet. Check back later!</p>
        </div>
      </div>
    `;
  }
  
  let housematesHTML = housemates.map(h => {
    const avatar = h.avatarUrl || getHousemateAvatar(h.sex);
    const isAvatarImage = h.avatarUrl && h.avatarUrl.startsWith('http');
    const statusLabel = h.status === 'in-game' ? '🏠 In Game' : '🚪 Evicted';
    const statusColor = h.status === 'in-game' ? '#4CAF50' : '#e94560';
    
    return `
      <div class="housemate-card" onclick="openHousemateDetail('${h.id}')" style="cursor:pointer;background:#1a1a2e;border-radius:16px;padding:1rem;text-align:center;border:1px solid #2a2a4e;transition:all 0.2s;">
        <div style="width:80px;height:80px;border-radius:50%;background:#2a2a4e;display:flex;align-items:center;justify-content:center;font-size:3rem;margin:0 auto 0.5rem;overflow:hidden;border:2px solid ${statusColor};">
          ${isAvatarImage ? `<img src="${avatar}" style="width:100%;height:100%;object-fit:cover;">` : avatar}
        </div>
        <div style="display:inline-block;padding:0.1rem 0.6rem;border-radius:10px;background:${statusColor}30;color:${statusColor};font-size:0.6rem;font-weight:600;margin-bottom:0.2rem;">${statusLabel}</div>
        <h4 style="color:#fffffe;margin-bottom:0.2rem;">${escapeHtml(h.name)}</h4>
        <p style="color:#6b7280;font-size:0.8rem;">${escapeHtml(h.state || '')} ${h.state && h.occupation ? '·' : ''} ${escapeHtml(h.occupation || '')}</p>
        <span style="display:inline-block;font-size:0.7rem;color:#e94560;background:#e9456020;padding:0.1rem 0.8rem;border-radius:12px;margin-top:0.3rem;">${h.sex === 'female' ? '♀' : '♂'} ${h.age || ''}</span>
      </div>
    `;
  }).join('');
  
  return `
    <div class="housemates-container" style="padding:1rem;">
      <h2 style="color:#fffffe;margin-bottom:1rem;">🏠 Housemates (${housemates.length})</h2>
      <div class="housemates-grid" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:1rem;">
        ${housematesHTML}
      </div>
    </div>
  `;
}

// ============================================================
// ===== ADMIN HOUSEMATES =====
// ============================================================

function renderAdminHousemates() {
  let housemateListHTML = housemates.map(h => {
    const statusLabel = h.status === 'in-game' ? '🏠 In Game' : '🚪 Evicted';
    const statusColor = h.status === 'in-game' ? '#4CAF50' : '#e94560';
    const avatar = h.avatarUrl || getHousemateAvatar(h.sex);
    const isAvatarImage = h.avatarUrl && h.avatarUrl.startsWith('http');
    
    return `
      <div style="display:flex;justify-content:space-between;align-items:center;background:#1a1a2e;padding:0.8rem 1rem;border-radius:10px;margin-bottom:0.5rem;border:1px solid #2a2a4e;">
        <div style="display:flex;align-items:center;gap:0.8rem;">
          <div style="width:40px;height:40px;border-radius:50%;background:#2a2a4e;display:flex;align-items:center;justify-content:center;font-size:1.5rem;overflow:hidden;">
            ${isAvatarImage ? `<img src="${avatar}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">` : avatar}
          </div>
          <div>
            <div style="color:#fffffe;font-weight:600;">${escapeHtml(h.name)}</div>
            <div style="font-size:0.7rem;color:${statusColor};">${statusLabel}</div>
            <div style="color:#6b7280;font-size:0.7rem;">${escapeHtml(h.state || 'N/A')} · ${h.sex || 'N/A'}</div>
          </div>
        </div>
        <div style="display:flex;gap:0.3rem;">
          <button onclick="toggleHousemateStatus('${h.id}')" style="background:#2a2a4e;border:none;color:#a7a9be;padding:0.3rem 0.8rem;border-radius:6px;cursor:pointer;font-size:0.7rem;">${h.status === 'in-game' ? '🚪 Evict' : '🏠 Reinstate'}</button>
          <button onclick="deleteHousemate('${h.id}')" style="background:#e94560;border:none;color:white;padding:0.3rem 0.8rem;border-radius:6px;cursor:pointer;font-size:0.7rem;">🗑️</button>
        </div>
      </div>
    `;
  }).join('');

  return `
    <div class="admin-housemates">
      <h2 style="color:#fffffe;font-size:1.2rem;margin-bottom:1rem;">🏠 Manage Housemates</h2>
      
      <div style="background:#1a1a2e;border-radius:16px;padding:1.5rem;border:1px solid #2a2a4e;margin-bottom:1rem;">
        <h3 style="color:#fffffe;font-size:1rem;margin-bottom:0.5rem;">Add New Housemate</h3>
        
        <div style="margin-bottom:0.5rem;">
          <label style="color:#a7a9be;font-size:0.9rem;display:block;margin-bottom:0.3rem;">Name *</label>
          <input type="text" id="adminHousemateName" style="width:100%;padding:0.6rem;background:#0f0e17;border:1px solid #2a2a4e;border-radius:10px;color:#fffffe;font-size:0.9rem;" placeholder="Full name">
        </div>
        
        <div style="margin-bottom:0.5rem;">
          <label style="color:#a7a9be;font-size:0.9rem;display:block;margin-bottom:0.3rem;">State</label>
          <input type="text" id="adminHousemateState" style="width:100%;padding:0.6rem;background:#0f0e17;border:1px solid #2a2a4e;border-radius:10px;color:#fffffe;font-size:0.9rem;" placeholder="State of origin">
        </div>
        
        <div style="margin-bottom:0.5rem;">
          <label style="color:#a7a9be;font-size:0.9rem;display:block;margin-bottom:0.3rem;">Occupation</label>
          <input type="text" id="adminHousemateOccupation" style="width:100%;padding:0.6rem;background:#0f0e17;border:1px solid #2a2a4e;border-radius:10px;color:#fffffe;font-size:0.9rem;" placeholder="Occupation">
        </div>
        
        <div style="margin-bottom:0.5rem;">
          <label style="color:#a7a9be;font-size:0.9rem;display:block;margin-bottom:0.3rem;">Sex *</label>
          <select id="adminHousemateSex" style="width:100%;padding:0.6rem;background:#0f0e17;border:1px solid #2a2a4e;border-radius:10px;color:#fffffe;font-size:0.9rem;">
            <option value="male">♂ Male</option>
            <option value="female">♀ Female</option>
          </select>
        </div>
        
        <div style="margin-bottom:0.5rem;">
          <label style="color:#a7a9be;font-size:0.9rem;display:block;margin-bottom:0.3rem;">Age</label>
          <input type="number" id="adminHousemateAge" style="width:100%;padding:0.6rem;background:#0f0e17;border:1px solid #2a2a4e;border-radius:10px;color:#fffffe;font-size:0.9rem;" placeholder="Age">
        </div>
        
        <div style="margin-bottom:0.5rem;">
          <label style="color:#a7a9be;font-size:0.9rem;display:block;margin-bottom:0.3rem;">Biography</label>
          <textarea id="adminHousemateBio" style="width:100%;background:#0f0e17;border:1px solid #2a2a4e;border-radius:10px;color:#fffffe;padding:0.8rem;font-size:0.9rem;resize:vertical;min-height:80px;font-family:inherit;" placeholder="Biography / More info about the housemate..."></textarea>
        </div>
        
        <div style="margin-bottom:0.5rem;">
          <label style="color:#a7a9be;font-size:0.9rem;display:block;margin-bottom:0.3rem;">Profile Image (optional)</label>
          <input type="file" id="adminHousemateImage" accept="image/*" onchange="previewAdminHousemateImage(event)">
          <div id="adminHousemateImagePreview"></div>
        </div>
        
        <button onclick="submitAdminHousemate()" style="width:100%;padding:0.8rem;background:#e94560;border:none;border-radius:10px;color:white;font-weight:600;cursor:pointer;">Add Housemate</button>
      </div>
      
      <h3 style="color:#fffffe;font-size:1rem;margin:1rem 0;">📋 Existing Housemates (${housemates.length})</h3>
      ${housemateListHTML || '<div style="color:#6b7280;text-align:center;padding:1rem;">No housemates added yet.</div>'}
    </div>
  `;
}

let adminHousemateImageFile = null;

function previewAdminHousemateImage(event) {
  const file = event.target.files[0];
  if (file) {
    adminHousemateImageFile = file;
    const reader = new FileReader();
    reader.onload = function(e) {
      document.getElementById('adminHousemateImagePreview').innerHTML = `<img src="${e.target.result}" style="max-width:100%;max-height:150px;border-radius:8px;margin-top:0.5rem;border:1px solid #2a2a4e;">`;
    };
    reader.readAsDataURL(file);
  }
}

async function submitAdminHousemate() {
  const name = document.getElementById('adminHousemateName');
  const state = document.getElementById('adminHousemateState');
  const occupation = document.getElementById('adminHousemateOccupation');
  const sex = document.getElementById('adminHousemateSex');
  const age = document.getElementById('adminHousemateAge');
  const bio = document.getElementById('adminHousemateBio');
  
  if (!name || !name.value.trim()) {
    alert('Please enter a name.');
    return;
  }
  
  let avatarUrl = '';
  let imageUrl = null;
  
  if (adminHousemateImageFile) {
    if (adminHousemateImageFile.size > MAX_UPLOAD_SIZE) {
      alert('Housemate image is larger than 3MB. Please select a smaller image.');
      adminHousemateImageFile = null;
      document.getElementById('adminHousemateImagePreview').innerHTML = '';
      document.getElementById('adminHousemateImage').value = '';
      return;
    }
    
    try {
      const compressed = await compressImage(adminHousemateImageFile, 400, 0.7);
      const urls = await uploadMultipleToR2([compressed], 'housemates');
      if (urls && urls.length > 0) {
        avatarUrl = urls[0];
        imageUrl = urls[0];
      } else {
        throw new Error('Image upload failed');
      }
    } catch (error) {
      console.error('Image upload error:', error);
      alert('Failed to upload image. Proceeding without image.');
    }
  }
  
  const housemateData = {
    name: name.value.trim(),
    state: state ? state.value.trim() : '',
    occupation: occupation ? occupation.value.trim() : '',
    sex: sex ? sex.value : 'male',
    age: age ? parseInt(age.value) || 0 : 0,
    biography: bio ? bio.value.trim() : '',
    avatarUrl: avatarUrl,
    status: 'in-game'
  };
  
  const success = await addHousemate(housemateData);
  
  if (!success && imageUrl) {
    await deleteR2Images([imageUrl]);
  }
  
  if (success) {
    if (name) name.value = '';
    if (state) state.value = '';
    if (occupation) occupation.value = '';
    if (age) age.value = '';
    if (bio) bio.value = '';
    adminHousemateImageFile = null;
    document.getElementById('adminHousemateImagePreview').innerHTML = '';
    document.getElementById('adminHousemateImage').value = '';
    renderAdminApp();
  }
}

async function toggleHousemateStatus(housemateId) {
  const housemate = housemates.find(h => h.id === housemateId);
  if (!housemate) return;
  
  const newStatus = housemate.status === 'in-game' ? 'evicted' : 'in-game';
  const statusLabel = newStatus === 'in-game' ? 'In Game' : 'Evicted';
  
  if (confirm(`Change ${housemate.name}'s status to "${statusLabel}"?`)) {
    await updateHousemateStatus(housemateId, newStatus);
    renderAdminApp();
  }
}

// ============================================================
// ===== ADMIN PREDICTIONS =====
// ============================================================

function renderAdminPredictions() {
  let predictionsListHTML = predictions.map(pred => {
    const isActive = pred.endsAt && new Date(pred.endsAt.toDate()) > new Date() && pred.correctAnswer === null;
    const statusLabel = isActive ? 'Active' : 'Ended';
    const statusColor = isActive ? '#4CAF50' : '#6b7280';
    const endsAtStr = pred.endsAt ? new Date(pred.endsAt.toDate()).toLocaleString() : 'N/A';
    
    let optionsHtml = pred.options ? pred.options.map(opt => `<option value="${opt}">${opt}</option>`).join('') : '';
    let setCorrectHtml = '';
    
    if (!isActive && pred.correctAnswer === null && pred.options && pred.options.length > 0) {
      setCorrectHtml = `
        <div style="display:flex;gap:0.3rem;margin-top:0.3rem;align-items:center;">
          <select id="setCorrect_${pred.id}" style="flex:1;padding:0.3rem;background:#0f0e17;border:1px solid #2a2a4e;border-radius:6px;color:#fffffe;font-size:0.8rem;">
            <option value="">— Select correct answer —</option>
            ${optionsHtml}
          </select>
          <button onclick="setAdminCorrectAnswer('${pred.id}')" style="background:#4CAF50;border:none;color:white;padding:0.3rem 0.8rem;border-radius:6px;cursor:pointer;font-size:0.7rem;white-space:nowrap;">
            ✅ Set
          </button>
        </div>
      `;
    } else if (pred.correctAnswer) {
      setCorrectHtml = `
        <div style="margin-top:0.3rem;padding:0.3rem 0.8rem;background:#0f0e17;border-radius:6px;">
          <span style="color:#4CAF50;">✅ Correct answer: <strong>${pred.correctAnswer}</strong></span>
        </div>
      `;
    }
    
    let viewButtonHtml = '';
    if (pred.correctAnswer !== null && pred.correctAnswer !== undefined) {
      viewButtonHtml = `
        <button onclick="viewPredictionUsers('${pred.id}')" style="background:#2a2a4e;border:none;color:#a7a9be;padding:0.2rem 0.8rem;border-radius:6px;cursor:pointer;font-size:0.7rem;margin-top:0.3rem;">
          👁️ View Users
        </button>
      `;
    }
    
    return `
      <div style="background:#1a1a2e;border-radius:12px;padding:1rem;margin-bottom:0.5rem;border:1px solid #2a2a4e;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;">
          <div style="flex:1;">
            <div style="color:#fffffe;font-weight:600;">${escapeHtml(pred.text)}</div>
            <div style="color:#6b7280;font-size:0.75rem;">${pred.options ? pred.options.join(' | ') : 'No options'}</div>
            <div style="color:#6b7280;font-size:0.7rem;">⏳ ${endsAtStr} • <span style="color:${statusColor};">${statusLabel}</span></div>
          </div>
          <div style="display:flex;gap:0.3rem;flex-direction:column;flex-shrink:0;margin-left:0.5rem;">
            ${viewButtonHtml}
          </div>
        </div>
        ${setCorrectHtml}
      </div>
    `;
  }).join('');

  return `
    <div class="admin-predictions">
      <h2 style="color:#fffffe;font-size:1.2rem;margin-bottom:1rem;">🏆 Manage Predictions</h2>
      
      <div style="background:#1a1a2e;border-radius:16px;padding:1.5rem;border:1px solid #2a2a4e;margin-bottom:1rem;">
        <h3 style="color:#fffffe;font-size:1rem;margin-bottom:0.5rem;">➕ Add New Prediction</h3>
        
        <div style="margin-bottom:0.5rem;">
          <label style="color:#a7a9be;font-size:0.9rem;display:block;margin-bottom:0.3rem;">Question *</label>
          <input type="text" id="adminPredText" style="width:100%;padding:0.6rem;background:#0f0e17;border:1px solid #2a2a4e;border-radius:10px;color:#fffffe;font-size:0.9rem;" placeholder="What's your prediction?">
        </div>
        
        <div style="margin-bottom:0.5rem;">
          <label style="color:#a7a9be;font-size:0.9rem;display:block;margin-bottom:0.3rem;">Options (comma separated) *</label>
          <input type="text" id="adminPredOptions" style="width:100%;padding:0.6rem;background:#0f0e17;border:1px solid #2a2a4e;border-radius:10px;color:#fffffe;font-size:0.9rem;" placeholder="Option 1, Option 2, Option 3">
        </div>
        
        <div style="margin-bottom:0.5rem;">
          <label style="color:#a7a9be;font-size:0.9rem;display:block;margin-bottom:0.3rem;">Voting Ends At *</label>
          <input type="datetime-local" id="adminPredEndsAt" style="width:100%;padding:0.6rem;background:#0f0e17;border:1px solid #2a2a4e;border-radius:10px;color:#fffffe;font-size:0.9rem;">
        </div>
        
        <div style="margin-bottom:0.5rem;">
          <label style="color:#a7a9be;font-size:0.9rem;display:block;margin-bottom:0.3rem;">Points Reward</label>
          <input type="number" id="adminPredPoints" style="width:100%;padding:0.6rem;background:#0f0e17;border:1px solid #2a2a4e;border-radius:10px;color:#fffffe;font-size:0.9rem;" value="100" placeholder="Points for correct prediction">
        </div>
        
        <button onclick="submitAdminPrediction()" style="width:100%;padding:0.8rem;background:#e94560;border:none;border-radius:10px;color:white;font-weight:600;cursor:pointer;">Add Prediction</button>
      </div>
      
      <h3 style="color:#fffffe;font-size:1rem;margin:1rem 0;">📋 Existing Predictions (${predictions.length})</h3>
      ${predictionsListHTML || '<div style="color:#6b7280;text-align:center;padding:1rem;">No predictions added yet.</div>'}
      
      <!-- Prediction Users Modal -->
      <div id="predictionUsersModal" style="display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.9);z-index:10000;justify-content:center;align-items:center;padding:1rem;overflow-y:auto;">
        <div style="background:#1a1a2e;border-radius:16px;padding:1.5rem;max-width:500px;width:100%;max-height:80vh;overflow-y:auto;border:1px solid #2a2a4e;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;">
            <h3 style="color:#fffffe;">👥 Users Who Got It Right</h3>
            <button onclick="closePredictionUsersModal()" style="background:none;border:none;color:#a7a9be;font-size:1.5rem;cursor:pointer;">✕</button>
          </div>
          <div id="predictionUsersList">
            <div style="text-align:center;padding:1rem;color:#6b7280;">Loading users...</div>
          </div>
        </div>
      </div>
    </div>
  `;
}

// ============================================================
// ===== ADMIN ADS =====
// ============================================================

function renderAdminAds() {
  let adsListHTML = allAds.map(ad => {
    const statusLabel = ad.status === 'approved' ? '✅ Approved' : 
                        ad.status === 'pending_payment' ? '⏳ Payment Pending' : 
                        ad.status === 'pending' ? '⏳ Pending' : 
                        ad.status === 'rejected' ? '❌ Rejected' : '⏳ Pending';
    const statusColor = ad.status === 'approved' ? '#4CAF50' : 
                        ad.status === 'pending_payment' ? '#FF9800' : 
                        ad.status === 'pending' ? '#FF9800' :
                        ad.status === 'rejected' ? '#e94560' : '#FF9800';
    const budgetLeft = ad.budgetLeft || 0;
    const totalImpressions = ad.totalImpressions || 0;
    const businessName = ad.businessName || 'Unknown';
    const userId = ad.userId || '';
    const uniqueCode = ad.uniqueCode || 'N/A';
    const paymentVerified = ad.paymentVerified || false;
    
    const user = allUsers.find(u => u.id === userId);
    const username = user?.username || 'Unknown User';
    
    let actions = '';
    if (ad.status === 'pending_payment') {
      actions = `<button onclick="verifyAdPayment('${ad.id}')" style="background:#4CAF50;border:none;color:white;padding:0.2rem 0.6rem;border-radius:4px;cursor:pointer;font-size:0.6rem;">✅ Verify Payment</button>`;
      actions += ` <button onclick="deleteAd('${ad.id}')" style="background:#e94560;border:none;color:white;padding:0.2rem 0.6rem;border-radius:4px;cursor:pointer;font-size:0.6rem;">🗑️</button>`;
    } else if (ad.status === 'pending') {
      actions = `<button onclick="approveAd('${ad.id}')" style="background:#4CAF50;border:none;color:white;padding:0.2rem 0.6rem;border-radius:4px;cursor:pointer;font-size:0.6rem;">Approve</button>`;
      actions += ` <button onclick="rejectAd('${ad.id}')" style="background:#e94560;border:none;color:white;padding:0.2rem 0.6rem;border-radius:4px;cursor:pointer;font-size:0.6rem;">Reject</button>`;
      actions += ` <button onclick="deleteAd('${ad.id}')" style="background:#e94560;border:none;color:white;padding:0.2rem 0.6rem;border-radius:4px;cursor:pointer;font-size:0.6rem;">🗑️</button>`;
    } else if (ad.status === 'approved') {
      actions = `<button onclick="deleteAd('${ad.id}')" style="background:#e94560;border:none;color:white;padding:0.2rem 0.6rem;border-radius:4px;cursor:pointer;font-size:0.6rem;">🗑️</button>`;
    }
    
    return `
      <div style="display:flex;justify-content:space-between;align-items:center;background:#1a1a2e;padding:0.6rem 0.8rem;border-radius:8px;margin-bottom:0.3rem;border:1px solid #2a2a4e;">
        <div style="display:flex;align-items:center;gap:0.5rem;flex:1;min-width:0;">
          ${ad.imageUrl ? `<img src="${ad.imageUrl}" style="width:32px;height:32px;border-radius:6px;object-fit:cover;flex-shrink:0;">` : '<div style="width:32px;height:32px;border-radius:6px;background:#2a2a4e;display:flex;align-items:center;justify-content:center;font-size:0.8rem;flex-shrink:0;">📢</div>'}
          <div style="overflow:hidden;">
            <div style="color:#fffffe;font-weight:600;font-size:0.85rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(businessName)}</div>
            <div style="font-size:0.65rem;color:${statusColor};">${statusLabel}</div>
            <div style="font-size:0.6rem;color:#6b7280;">👤 ${escapeHtml(username)} · 💰 ₦${budgetLeft.toLocaleString()} left · 👁️ ${totalImpressions.toLocaleString()}</div>
            <div style="font-size:0.55rem;color:#6b7280;font-family:monospace;">🔑 ${uniqueCode} ${paymentVerified ? '✅ Verified' : ''}</div>
          </div>
        </div>
        <div style="display:flex;gap:0.2rem;flex-shrink:0;flex-wrap:wrap;">
          ${actions}
        </div>
      </div>
    `;
  }).join('');

  return `
    <div class="admin-ads">
      <h2 style="color:#fffffe;font-size:1.2rem;margin-bottom:1rem;">📢 Manage Ads</h2>
      
      <div style="background:#1a1a2e;border-radius:16px;padding:1.5rem;border:1px solid #2a2a4e;margin-bottom:1rem;">
        <h3 style="color:#fffffe;font-size:1rem;margin-bottom:0.5rem;">📋 All Ad Requests (${allAds.length})</h3>
        <div style="font-size:0.7rem;color:#6b7280;margin-bottom:0.5rem;">
          💡 To approve an ad: Check that the user sent the exact amount with the unique code in the remark.
          Then click "Verify Payment" to approve and activate the ad.
        </div>
        ${adsListHTML || '<div style="color:#6b7280;text-align:center;padding:1rem;">No ad requests yet.</div>'}
      </div>
      
      <div style="background:#1a1a2e;border-radius:16px;padding:1.5rem;border:1px solid #2a2a4e;">
        <h3 style="color:#fffffe;font-size:1rem;margin-bottom:0.5rem;">📊 Active Ads (${approvedAds.length})</h3>
        ${approvedAds.map(ad => `
          <div style="display:flex;justify-content:space-between;align-items:center;background:#0f0e17;padding:0.5rem 0.8rem;border-radius:6px;margin-bottom:0.3rem;border:1px solid #2a2a4e;">
            <div>
              <div style="color:#fffffe;font-weight:600;font-size:0.85rem;">${escapeHtml(ad.businessName)}</div>
              <div style="font-size:0.65rem;color:#6b7280;">💰 ₦${(ad.budgetLeft || 0).toLocaleString()} left · 👁️ ${(ad.totalImpressions || 0).toLocaleString()}</div>
              <div style="font-size:0.55rem;color:#6b7280;font-family:monospace;">🔑 ${ad.uniqueCode || 'N/A'}</div>
            </div>
            <div style="font-size:0.65rem;color:#4CAF50;">✅ Active</div>
          </div>
        `).join('') || '<div style="color:#6b7280;text-align:center;padding:1rem;">No active ads.</div>'}
      </div>
    </div>
  `;
}

async function approveAd(adId) {
  if (!confirm('Approve this ad request?')) return;
  try {
    const adRef = db.collection('ads').doc(adId);
    const adDoc = await adRef.get();
    if (!adDoc.exists) {
      showToast('Ad not found.', false);
      return;
    }
    const adData = adDoc.data();
    await adRef.update({
      status: 'approved',
      approvedAt: firebase.firestore.FieldValue.serverTimestamp(),
      budgetLeft: adData.amount || 0
    });
    dataManager.invalidateCache('ads');
    showToast('✅ Ad approved!', true);
    renderAdminApp();
  } catch (error) {
    console.error('Error approving ad:', error);
    showToast('❌ Failed to approve ad: ' + error.message, false);
  }
}

async function rejectAd(adId) {
  if (!confirm('Reject this ad request?')) return;
  try {
    const adRef = db.collection('ads').doc(adId);
    await adRef.update({
      status: 'rejected',
      rejectedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    dataManager.invalidateCache('ads');
    showToast('✅ Ad rejected.', true);
    renderAdminApp();
  } catch (error) {
    console.error('Error rejecting ad:', error);
    showToast('❌ Failed to reject ad.', false);
  }
}

async function deleteAd(adId) {
  if (!confirm('Are you sure you want to delete this ad?')) return;
  try {
    await db.collection('ads').doc(adId).delete();
    dataManager.invalidateCache('ads');
    showToast('✅ Ad deleted!', true);
    renderAdminApp();
  } catch (error) {
    console.error('Error deleting ad:', error);
    showToast('❌ Failed to delete ad.', false);
  }
}

// ============================================================
// ===== NOTIFICATIONS (User) =====
// ============================================================

function renderNotifications() {
  if (!isDataLoaded) {
    return `<div style="text-align:center;padding:2rem;color:#6b7280;">Loading notifications...</div>`;
  }
  
  let notifHTML = notifications.map(n => `
    <div class="notification-item" style="${n.read ? 'opacity:0.5;' : ''};cursor:pointer;" onclick="openNotificationDetail(getNotificationById('${n.id}'))">
      <span class="notif-icon">${n.type === 'admin' ? '📢' : n.type === 'reply' ? '💬' : '🏷️'}</span>
      <div style="flex:1;">
        <p style="${n.read ? 'color:#6b7280;' : 'color:#fffffe;'}">${n.message}</p>
        <span class="notif-time">${n.time}</span>
        ${!n.read ? `<span style="margin-left:0.5rem;color:#e94560;font-size:0.7rem;">● New</span>` : ''}
        ${n.postId ? `<span style="margin-left:0.5rem;color:#e94560;font-size:0.6rem;background:#2a2a4e;padding:0.1rem 0.5rem;border-radius:10px;">📄</span>` : ''}
        ${n.commentId ? `<span style="margin-left:0.3rem;color:#e94560;font-size:0.6rem;background:#2a2a4e;padding:0.1rem 0.5rem;border-radius:10px;">💬</span>` : ''}
      </div>
      <span style="color:#6b7280;font-size:0.8rem;">›</span>
    </div>
  `).join('');
  
  return `
    <div class="notifications-container">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;">
        <h2 style="color:#fffffe;font-size:1.2rem;">🔔 Notifications</h2>
        <span style="color:#e94560;font-size:0.8rem;font-weight:600;">${notificationCount} new</span>
      </div>
      ${notifHTML || '<div style="color:#6b7280;text-align:center;padding:2rem 0;">No notifications yet</div>'}
      ${notificationCount > 0 ? `<button onclick="markAllNotificationsRead()" style="width:100%;padding:0.5rem;background:#1a1a2e;border:1px solid #2a2a4e;border-radius:10px;color:#a7a9be;cursor:pointer;margin-top:0.5rem;">Mark all as read</button>` : ''}
    </div>
  `;
}

// ============================================================
// ===== PROFILE PAGE =====
// ============================================================

function loadPage(page) {
  if (page === 'profile') {
    renderProfilePage();
  } else if (page === 'feed') {
    switchTab('feed');
  } else if (page === 'community') {
    switchTab('community');
  } else if (page === 'notifications') {
    switchTab('notifications');
  } else if (page === 'ads') {
    openAdsScreen();
  } else if (page === 'settings') {
    renderSettingsPage();
  }
}

async function renderProfilePage() {
  const user = currentUser;
  if (!user) {
    showToast('Please sign in to view your profile', false);
    return;
  }
  
  root.innerHTML = `
    <div style="padding:2rem;text-align:center;color:#6b7280;">
      <div style="width:40px;height:40px;border:3px solid #2a2a4e;border-top-color:#e94560;border-radius:50%;animation:spin 1s linear infinite;margin:0 auto 1rem;"></div>
      <p>Loading profile...</p>
    </div>
  `;
  
  try {
    let userData = profileDataCache;
    if (!userData) {
      const userRef = db.collection('users').doc(user.uid);
      const userDoc = await userRef.get();
      
      if (!userDoc.exists) {
        await userRef.set({
          username: user.displayName || user.email.split('@')[0],
          email: user.email,
          totalPoints: 0,
          accuracy: 0,
          predictions: 0,
          correctPredictions: 0,
          profilePic: null,
          createdAt: new Date()
        });
        const newDoc = await userRef.get();
        userData = newDoc.data();
      } else {
        userData = userDoc.data();
      }
      profileDataCache = userData;
      currentUserProfile = userData;
    }
    
    const username = userData.username || user.displayName || 'User';
    const points = userData.totalPoints || 0;
    const accuracy = userData.accuracy || 0;
    const predictions = userData.predictions || 0;
    const correctPredictions = userData.correctPredictions || 0;
    const profilePic = userData.profilePic || null;
    
    let leaderboard = [];
    let userRank = 1;
    try {
      const cachedLeaderboard = localStorage.getItem('dhouse_leaderboard');
      let useCache = false;
      if (cachedLeaderboard) {
        try {
          const parsed = JSON.parse(cachedLeaderboard);
          if (Date.now() - parsed.timestamp < 60000) {
            leaderboard = parsed.data;
            useCache = true;
          }
        } catch (e) {}
      }
      
      if (!useCache) {
        const allUsersSnapshot = await db.collection('users').orderBy('totalPoints', 'desc').get();
        leaderboard = [];
        allUsersSnapshot.forEach((doc) => {
          const data = doc.data();
          leaderboard.push({
            id: doc.id,
            username: data.username || 'User',
            points: data.totalPoints || 0
          });
        });
        localStorage.setItem('dhouse_leaderboard', JSON.stringify({
          data: leaderboard,
          timestamp: Date.now()
        }));
      }
      
      leaderboard.forEach((item, index) => {
        if (item.id === user.uid) userRank = index + 1;
      });
    } catch (e) {
      console.warn('Failed to load leaderboard:', e);
    }
    
    const top10 = leaderboard.slice(0, 10);
    
    let leaderboardHTML = '';
    let userInTop10 = false;
    
    if (top10.length === 0) {
      leaderboardHTML = '<div style="color:#6b7280;text-align:center;padding:1rem;">No users yet</div>';
    } else {
      top10.forEach((item, index) => {
        const isCurrentUser = item.id === user.uid;
        if (isCurrentUser) userInTop10 = true;
        const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}`;
        
        leaderboardHTML += `
          <div class="leaderboard-item ${isCurrentUser ? 'highlight' : ''}" style="display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:12px;background:#0f0e17;margin-bottom:6px;${isCurrentUser ? 'border:2px solid #e94560;background:rgba(233,69,96,0.1);' : ''}">
            <span style="font-weight:bold;font-size:14px;color:#888;min-width:32px;">${medal}</span>
            <div style="width:32px;height:32px;border-radius:50%;background:#e94560;display:flex;align-items:center;justify-content:center;font-weight:bold;font-size:14px;flex-shrink:0;color:white;">${item.username.charAt(0).toUpperCase()}</div>
            <div style="flex:1;">
              <div style="font-size:14px;font-weight:500;color:#fffffe;">${escapeHtml(item.username)} ${isCurrentUser ? '👈 You' : ''}</div>
              <div style="font-size:12px;color:#FFB300;">⭐ ${item.points} points</div>
            </div>
            ${isCurrentUser ? '<div style="font-size:12px;padding:2px 10px;border-radius:12px;background:#e94560;color:white;font-weight:bold;">YOU</div>' : ''}
          </div>
        `;
      });
    }
    
    if (!userInTop10 && leaderboard.length > 0) {
      const userData = leaderboard.find(item => item.id === user.uid);
      if (userData) {
        leaderboardHTML += `
          <div class="leaderboard-item highlight" style="display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:12px;background:#0f0e17;margin-bottom:6px;border:2px solid #e94560;background:rgba(233,69,96,0.1);">
            <span style="font-weight:bold;font-size:14px;color:#888;min-width:32px;">${userRank}</span>
            <div style="width:32px;height:32px;border-radius:50%;background:#e94560;display:flex;align-items:center;justify-content:center;font-weight:bold;font-size:14px;flex-shrink:0;color:white;">${userData.username.charAt(0).toUpperCase()}</div>
            <div style="flex:1;">
              <div style="font-size:14px;font-weight:500;color:#fffffe;">${escapeHtml(userData.username)} 👈 You</div>
              <div style="font-size:12px;color:#FFB300;">⭐ ${userData.points} points</div>
            </div>
            <div style="font-size:12px;padding:2px 10px;border-radius:12px;background:#e94560;color:white;font-weight:bold;">YOU</div>
          </div>
        `;
      }
    }
    
    const profileHTML = `
      <div class="profile-page" style="padding:1rem;max-width:500px;margin:0 auto;padding-bottom:80px;">
        <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.5rem;">
          <button onclick="switchTab('community')" style="background:none;border:none;color:#fffffe;font-size:1.5rem;cursor:pointer;">←</button>
          <span style="color:#fffffe;font-weight:600;font-size:1.1rem;">Profile</span>
        </div>
        
        <div style="background:#1a1a2e;border-radius:16px;padding:1.5rem;text-align:center;border:1px solid #2a2a4e;margin-bottom:1rem;">
          <div style="position:relative;width:80px;height:80px;margin:0 auto 1rem;">
            <div class="profile-avatar" onclick="document.getElementById('profilePicInput').click()" style="width:100%;height:100%;border-radius:50%;background:#e94560;display:flex;align-items:center;justify-content:center;font-size:2rem;font-weight:bold;color:white;border:3px solid #e94560;overflow:hidden;cursor:pointer;">
              ${profilePic ? `<img src="${profilePic}" alt="Profile" style="width:100%;height:100%;object-fit:cover;">` : username.charAt(0).toUpperCase()}
            </div>
            <div onclick="document.getElementById('profilePicInput').click()" style="position:absolute;bottom:0;right:0;background:#1a1a2e;border:2px solid #0f0e17;border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-size:0.7rem;color:#a7a9be;cursor:pointer;">📷</div>
          </div>
          <h2 style="color:#fffffe;font-size:1.5rem;margin-bottom:0.2rem;">${escapeHtml(username)}</h2>
          <p style="color:#6b7280;font-size:0.85rem;margin-bottom:0.5rem;">${user.email}</p>
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:0.5rem;margin-top:0.5rem;">
            <div style="background:#0f0e17;border-radius:12px;padding:0.8rem 0.5rem;">
              <div style="color:#FFB300;font-size:1.5rem;font-weight:bold;">${points}</div>
              <div style="color:#6b7280;font-size:0.7rem;">Points</div>
            </div>
            <div style="background:#0f0e17;border-radius:12px;padding:0.8rem 0.5rem;">
              <div style="color:#FFB300;font-size:1.5rem;font-weight:bold;">${accuracy}%</div>
              <div style="color:#6b7280;font-size:0.7rem;">Accuracy</div>
            </div>
            <div style="background:#0f0e17;border-radius:12px;padding:0.8rem 0.5rem;">
              <div style="color:#FFB300;font-size:1.5rem;font-weight:bold;">${correctPredictions}/${predictions}</div>
              <div style="color:#6b7280;font-size:0.7rem;">Predictions</div>
            </div>
          </div>
          <input type="file" id="profilePicInput" accept="image/*" style="display:none;" onchange="updateProfilePic(event)">
        </div>
        
        <div style="background:#1a1a2e;border-radius:16px;padding:1rem;border:1px solid #2a2a4e;margin-bottom:1rem;">
          <h3 style="color:#fffffe;font-size:1.1rem;margin-bottom:0.5rem;">🏆 Leaderboard</h3>
          ${leaderboardHTML}
        </div>
        
        <button onclick="handleLogoutWithDialog()" style="width:100%;padding:0.8rem;background:#e94560;border:none;border-radius:12px;color:white;font-weight:600;cursor:pointer;font-size:1rem;">
          🚪 Logout
        </button>
      </div>
    `;
    
    root.innerHTML = profileHTML;
    
  } catch (error) {
    console.error('Error loading profile:', error);
    root.innerHTML = `
      <div style="padding:2rem;text-align:center;color:#6b7280;max-width:400px;margin:0 auto;">
        <p style="font-size:2rem;margin-bottom:0.5rem;">😕</p>
        <p style="margin-bottom:0.5rem;">Couldn't load your profile</p>
        <p style="font-size:0.85rem;color:#555;margin-bottom:1rem;">${error.message || 'Please try again'}</p>
        <button onclick="renderProfilePage()" style="padding:0.6rem 2rem;background:#e94560;border:none;border-radius:12px;color:white;cursor:pointer;font-size:1rem;">Retry</button>
      </div>
    `;
  }
}

async function updateProfilePic(event) {
  const file = event.target.files[0];
  if (!file) return;
  
  if (file.size > MAX_UPLOAD_SIZE) {
    alert('Profile picture is larger than 3MB. Please select a smaller image.');
    event.target.value = '';
    return;
  }
  
  let imageUrl = null;
  
  try {
    showToast('📤 Uploading...', true);
    
    const compressed = await compressImage(file, 400, 0.7);
    imageUrl = await uploadProfileImage(compressed);
    
    if (!imageUrl) {
      throw new Error('Image upload failed');
    }
    
    await db.collection('users').doc(currentUser.uid).update({
      profilePic: imageUrl
    });
    
    profileDataCache = null;
    dataManager.invalidateCache(`user_${currentUser.uid}`);
    showToast('✅ Profile picture updated!', true);
    renderProfilePage();
  } catch (error) {
    console.error('Error updating profile pic:', error);
    
    if (imageUrl) {
      await deleteR2Images([imageUrl]);
    }
    
    showToast('❌ Failed to update profile picture.', false);
    event.target.value = '';
  }
}

// ============================================================
// ===== SETTINGS SCREEN =====
// ============================================================

function renderSettingsPage() {
  const cacheSize = getCacheSize();
  const user = currentUser;
  
  root.innerHTML = `
    <div class="settings-page" style="min-height:100vh;background:#0A0A0A;padding:1rem;max-width:500px;margin:0 auto;padding-bottom:80px;">
      
      <!-- Header -->
      <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:1.5rem;">
        <button onclick="renderMainApp()" style="background:none;border:none;color:#fffffe;font-size:1.5rem;cursor:pointer;">←</button>
        <span style="color:#fffffe;font-weight:600;font-size:1.2rem;">⚙️ Settings</span>
      </div>
      
      <!-- Profile Section -->
      <div style="background:#1a1a2e;border-radius:16px;padding:1rem;border:1px solid #2a2a4e;margin-bottom:1rem;">
        <div style="display:flex;align-items:center;gap:0.8rem;">
          <div style="width:56px;height:56px;border-radius:50%;background:#e94560;display:flex;align-items:center;justify-content:center;font-size:1.5rem;font-weight:bold;color:white;">
            ${user?.displayName?.[0]?.toUpperCase() || user?.email?.[0]?.toUpperCase() || 'U'}
          </div>
          <div style="flex:1;">
            <div style="color:#fffffe;font-weight:600;">${user?.displayName || 'User'}</div>
            <div style="color:#6b7280;font-size:0.8rem;">${user?.email}</div>
            <div style="color:#FFB300;font-size:0.8rem;">⭐ ${currentUserPoints || 0} points</div>
          </div>
          <button onclick="loadPage('profile')" style="background:#2a2a4e;border:none;color:#a7a9be;padding:0.3rem 0.8rem;border-radius:12px;cursor:pointer;font-size:0.8rem;">Edit</button>
        </div>
      </div>
      
      <!-- Image Quality -->
      <div style="background:#1a1a2e;border-radius:16px;padding:0.5rem 0;border:1px solid #2a2a4e;margin-bottom:1rem;overflow:hidden;">
        <div style="padding:0.8rem 1rem;color:#a7a9be;font-size:0.7rem;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #2a2a4e;">🎨 Image Quality</div>
        
        <div style="display:flex;justify-content:space-between;align-items:center;padding:0.8rem 1rem;">
          <span style="color:#fffffe;">Image Quality</span>
          <div style="display:flex;gap:0.3rem;">
            <button onclick="setImageQuality('low')" style="background:${settingsData.imageQuality === 'low' ? '#e94560' : '#2a2a4e'};border:none;color:white;padding:0.2rem 0.8rem;border-radius:8px;cursor:pointer;font-size:0.7rem;">Low</button>
            <button onclick="setImageQuality('medium')" style="background:${settingsData.imageQuality === 'medium' ? '#e94560' : '#2a2a4e'};border:none;color:white;padding:0.2rem 0.8rem;border-radius:8px;cursor:pointer;font-size:0.7rem;">Med</button>
            <button onclick="setImageQuality('high')" style="background:${settingsData.imageQuality === 'high' ? '#e94560' : '#2a2a4e'};border:none;color:white;padding:0.2rem 0.8rem;border-radius:8px;cursor:pointer;font-size:0.7rem;">High</button>
          </div>
        </div>
      </div>
      
      <!-- Notifications -->
      <div style="background:#1a1a2e;border-radius:16px;padding:0.5rem 0;border:1px solid #2a2a4e;margin-bottom:1rem;overflow:hidden;">
        <div style="padding:0.8rem 1rem;color:#a7a9be;font-size:0.7rem;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #2a2a4e;">🔔 Notifications</div>
        
        <div style="display:flex;justify-content:space-between;align-items:center;padding:0.8rem 1rem;border-bottom:1px solid #2a2a4e;">
          <span style="color:#fffffe;">Push Notifications</span>
          <label style="position:relative;display:inline-block;width:48px;height:28px;cursor:pointer;">
            <input type="checkbox" ${settingsData.pushNotifications ? 'checked' : ''} style="opacity:0;width:0;height:0;" onchange="toggleNotification('push')">
            <span style="position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;background:${settingsData.pushNotifications ? '#e94560' : '#2a2a4e'};border-radius:14px;transition:0.3s;"></span>
            <span style="position:absolute;content:'';height:20px;width:20px;left:${settingsData.pushNotifications ? '24px' : '4px'};bottom:4px;background:white;border-radius:50%;transition:0.3s;"></span>
          </label>
        </div>
        
        <div style="display:flex;justify-content:space-between;align-items:center;padding:0.8rem 1rem;border-bottom:1px solid #2a2a4e;">
          <span style="color:#fffffe;">Reply Notifications</span>
          <label style="position:relative;display:inline-block;width:48px;height:28px;cursor:pointer;">
            <input type="checkbox" ${settingsData.replyNotifications ? 'checked' : ''} style="opacity:0;width:0;height:0;" onchange="toggleNotification('reply')">
            <span style="position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;background:${settingsData.replyNotifications ? '#e94560' : '#2a2a4e'};border-radius:14px;transition:0.3s;"></span>
            <span style="position:absolute;content:'';height:20px;width:20px;left:${settingsData.replyNotifications ? '24px' : '4px'};bottom:4px;background:white;border-radius:50%;transition:0.3s;"></span>
          </label>
        </div>
        
        <div style="display:flex;justify-content:space-between;align-items:center;padding:0.8rem 1rem;">
          <span style="color:#fffffe;">Tag Notifications</span>
          <label style="position:relative;display:inline-block;width:48px;height:28px;cursor:pointer;">
            <input type="checkbox" ${settingsData.tagNotifications ? 'checked' : ''} style="opacity:0;width:0;height:0;" onchange="toggleNotification('tag')">
            <span style="position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;background:${settingsData.tagNotifications ? '#e94560' : '#2a2a4e'};border-radius:14px;transition:0.3s;"></span>
            <span style="position:absolute;content:'';height:20px;width:20px;left:${settingsData.tagNotifications ? '24px' : '4px'};bottom:4px;background:white;border-radius:50%;transition:0.3s;"></span>
          </label>
        </div>
      </div>
      
      <!-- Data & Storage -->
      <div style="background:#1a1a2e;border-radius:16px;padding:0.5rem 0;border:1px solid #2a2a4e;margin-bottom:1rem;overflow:hidden;">
        <div style="padding:0.8rem 1rem;color:#a7a9be;font-size:0.7rem;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #2a2a4e;">💾 Data & Storage</div>
        
        <div style="display:flex;justify-content:space-between;align-items:center;padding:0.8rem 1rem;border-bottom:1px solid #2a2a4e;">
          <span style="color:#fffffe;">Cache Size</span>
          <span style="color:#6b7280;font-size:0.8rem;">${cacheSize} MB</span>
        </div>
        
        <div style="display:flex;justify-content:space-between;align-items:center;padding:0.8rem 1rem;">
          <span style="color:#fffffe;">Clear Cache</span>
          <button onclick="clearCache()" style="background:#e94560;border:none;color:white;padding:0.3rem 1rem;border-radius:12px;cursor:pointer;font-size:0.8rem;">🗑️ Clear</button>
        </div>
      </div>
      
      <!-- Content -->
      <div style="background:#1a1a2e;border-radius:16px;padding:0.5rem 0;border:1px solid #2a2a4e;margin-bottom:1rem;overflow:hidden;">
        <div style="padding:0.8rem 1rem;color:#a7a9be;font-size:0.7rem;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #2a2a4e;">📝 Content</div>
        
        <div style="display:flex;justify-content:space-between;align-items:center;padding:0.8rem 1rem;">
          <span style="color:#fffffe;">Auto-Play Videos</span>
          <label style="position:relative;display:inline-block;width:48px;height:28px;cursor:pointer;">
            <input type="checkbox" ${settingsData.autoPlay ? 'checked' : ''} style="opacity:0;width:0;height:0;" onchange="toggleAutoPlay()">
            <span style="position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;background:${settingsData.autoPlay ? '#e94560' : '#2a2a4e'};border-radius:14px;transition:0.3s;"></span>
            <span style="position:absolute;content:'';height:20px;width:20px;left:${settingsData.autoPlay ? '24px' : '4px'};bottom:4px;background:white;border-radius:50%;transition:0.3s;"></span>
          </label>
        </div>
      </div>
      
      <!-- Support -->
      <div style="background:#1a1a2e;border-radius:16px;padding:0.5rem 0;border:1px solid #2a2a4e;margin-bottom:1rem;overflow:hidden;">
        <div style="padding:0.8rem 1rem;color:#a7a9be;font-size:0.7rem;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #2a2a4e;">❓ Support</div>
        
        <div onclick="showHelp()" style="display:flex;justify-content:space-between;align-items:center;padding:0.8rem 1rem;border-bottom:1px solid #2a2a4e;cursor:pointer;">
          <span style="color:#fffffe;">📖 Help Center</span>
          <span style="color:#6b7280;">→</span>
        </div>
        
        <div onclick="reportProblem()" style="display:flex;justify-content:space-between;align-items:center;padding:0.8rem 1rem;border-bottom:1px solid #2a2a4e;cursor:pointer;">
          <span style="color:#fffffe;">🐛 Report a Problem</span>
          <span style="color:#6b7280;">→</span>
        </div>
        
        <div onclick="sendFeedback()" style="display:flex;justify-content:space-between;align-items:center;padding:0.8rem 1rem;cursor:pointer;">
          <span style="color:#fffffe;">💬 Send Feedback</span>
          <span style="color:#6b7280;">→</span>
        </div>
      </div>
      
      <!-- About -->
      <div style="background:#1a1a2e;border-radius:16px;padding:0.5rem 0;border:1px solid #2a2a4e;margin-bottom:1rem;overflow:hidden;">
        <div style="padding:0.8rem 1rem;color:#a7a9be;font-size:0.7rem;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #2a2a4e;">ℹ️ About</div>
        
        <div style="display:flex;justify-content:space-between;align-items:center;padding:0.8rem 1rem;border-bottom:1px solid #2a2a4e;">
          <span style="color:#fffffe;">Version</span>
          <span style="color:#6b7280;font-size:0.8rem;">v2.0.0</span>
        </div>
        
        <div onclick="viewPrivacy()" style="display:flex;justify-content:space-between;align-items:center;padding:0.8rem 1rem;border-bottom:1px solid #2a2a4e;cursor:pointer;">
          <span style="color:#fffffe;">🔒 Privacy Policy</span>
          <span style="color:#6b7280;">→</span>
        </div>
      </div>
      
      <!-- Logout -->
      <button onclick="handleLogoutWithDialog()" style="width:100%;padding:0.8rem;background:#e94560;border:none;border-radius:12px;color:white;font-weight:600;cursor:pointer;font-size:1rem;margin-top:0.5rem;">
        🚪 Logout
      </button>
    </div>
  `;
}

// ============================================================
// ===== SETTINGS HELPER FUNCTIONS =====
// ============================================================

function toggleNotification(type) {
  switch(type) {
    case 'push':
      settingsData.pushNotifications = !settingsData.pushNotifications;
      localStorage.setItem('dhouse_push_notif', settingsData.pushNotifications);
      break;
    case 'reply':
      settingsData.replyNotifications = !settingsData.replyNotifications;
      localStorage.setItem('dhouse_reply_notif', settingsData.replyNotifications);
      break;
    case 'tag':
      settingsData.tagNotifications = !settingsData.tagNotifications;
      localStorage.setItem('dhouse_tag_notif', settingsData.tagNotifications);
      break;
  }
  renderSettingsPage();
}

function toggleAutoPlay() {
  settingsData.autoPlay = !settingsData.autoPlay;
  localStorage.setItem('dhouse_autoplay', settingsData.autoPlay);
  renderSettingsPage();
}

function setImageQuality(quality) {
  settingsData.imageQuality = quality;
  localStorage.setItem('dhouse_image_quality', quality);
  renderSettingsPage();
}

function getCacheSize() {
  let total = 0;
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith('cache_') || key.startsWith('dhouse_')) {
      total += localStorage.getItem(key)?.length || 0;
    }
  }
  return (total / 1024 / 1024).toFixed(2);
}

async function clearCache() {
  if (confirm('Clear all cached data? This will free up storage space.')) {
    try {
      const keys = Object.keys(localStorage);
      for (const key of keys) {
        if (key.startsWith('cache_') || key.startsWith('dhouse_')) {
          localStorage.removeItem(key);
        }
      }
      if (window.cache) {
        window.cache.clear();
      }
      dataManager.invalidateAllCache();
      showToast('✅ Cache cleared successfully!', true);
      renderSettingsPage();
    } catch (error) {
      console.error('Error clearing cache:', error);
      showToast('❌ Failed to clear cache.', false);
    }
  }
}

function showHelp() {
  showToast('📖 Help Center: For assistance, contact support@dhouse.com', true);
}

async function reportProblem() {
  const problem = prompt('Describe the problem you\'re experiencing:');
  if (problem && problem.trim()) {
    showToast('📤 Sending report...', true);
    
    const config = await getAdminConfig();
    const adminEmail = config?.adminEmail || 'cashplug318@gmail.com';
    
    submitFeedback(
      currentUser?.uid || 'anonymous',
      currentUser?.displayName || 'Anonymous',
      currentUser?.email || '',
      problem,
      'report'
    ).then(success => {
      if (success) {
        showToast('✅ Report sent! We\'ll look into it.', true);
        sendNotificationToUser(adminEmail, `New Problem Report from ${currentUser?.displayName || 'User'}: ${problem}`);
      } else {
        showToast('❌ Failed to send report. Please try again.', false);
      }
    });
  }
}

async function sendFeedback() {
  const feedback = prompt('Share your feedback or suggestions:');
  if (feedback && feedback.trim()) {
    showToast('📤 Sending feedback...', true);
    
    const config = await getAdminConfig();
    const adminEmail = config?.adminEmail || 'cashplug318@gmail.com';
    
    const success = await submitFeedback(
      currentUser?.uid || 'anonymous',
      currentUser?.displayName || 'Anonymous',
      currentUser?.email || '',
      feedback,
      'feedback'
    );
    
    if (success) {
      showToast('✅ Feedback sent! Thank you!', true);
      await sendNotificationToUser(adminEmail, `New Feedback from ${currentUser?.displayName || 'User'}: ${feedback}`);
    } else {
      showToast('❌ Failed to send feedback. Please try again.', false);
    }
  }
}

function viewPrivacy() {
  showToast('📋 Privacy Policy: Your data is secure and only used within the app.', true);
}

// ============================================================
// ===== COMMENT BOTTOM SHEET =====
// ============================================================

function openCommentSheet(postId, postType = 'community') {
  if (!currentUser) {
    showToast('Please sign in to comment', false);
    return;
  }
  
  currentCommentPostId = postId;
  currentCommentPostType = postType;
  commentSheetReplyingTo = null;
  commentSheetReplyingToUsername = '';
  commentSheetComments = [];
  commentSheetLastDoc = null;
  commentSheetHasMore = true;
  
  document.getElementById('commentSheetOverlay').classList.add('open');
  
  const sheet = document.getElementById('commentSheet');
  sheet.classList.add('open');
  
  const replyIndicator = document.getElementById('commentReplyIndicator');
  replyIndicator.classList.remove('show');
  document.getElementById('commentReplyToName').textContent = '';
  document.getElementById('commentReplyToId').value = '';
  
  document.getElementById('commentSheetInput').value = '';
  document.getElementById('commentSheetInput').placeholder = 'Write a comment...';
  
  loadCommentSheetComments(postId, postType, true);
}

function closeCommentSheet() {
  document.getElementById('commentSheetOverlay').classList.remove('open');
  document.getElementById('commentSheet').classList.remove('open');
  currentCommentPostId = null;
  commentSheetReplyingTo = null;
  commentSheetReplyingToUsername = '';
}

async function loadCommentSheetComments(postId, postType, reset = false) {
  if (commentSheetIsLoading) return;
  if (!commentSheetHasMore && !reset) return;
  
  commentSheetIsLoading = true;
  
  const container = document.getElementById('commentSheetBody');
  if (reset) {
    container.innerHTML = `
      <div class="comment-sheet-loading">
        <div class="spinner"></div>
        <p>Loading comments...</p>
      </div>
    `;
  }
  
  try {
    const collectionPath = postType === 'feed' 
      ? `feed_posts/${postId}/comments` 
      : `community_posts/${postId}/comments`;
    
    let q;
    if (reset || !commentSheetLastDoc) {
      q = db.collection(collectionPath)
        .orderBy('timestamp', 'desc')
        .limit(30);
    } else {
      q = db.collection(collectionPath)
        .orderBy('timestamp', 'desc')
        .startAfter(commentSheetLastDoc)
        .limit(30);
    }
    
    const snapshot = await q.get();
    
    if (snapshot.empty) {
      commentSheetHasMore = false;
      if (reset) {
        container.innerHTML = `
          <div class="comment-sheet-empty">
            <span class="comment-sheet-empty-icon">💬</span>
            <p>No comments yet. Be the first to comment!</p>
          </div>
        `;
      }
      commentSheetIsLoading = false;
      return;
    }
    
    const allComments = [];
    snapshot.forEach(doc => {
      allComments.push({ id: doc.id, ...doc.data() });
    });
    
    const commentMap = {};
    const topLevel = [];
    
    for (const comment of allComments) {
      commentMap[comment.id] = { ...comment, replies: [] };
    }
    
    for (const comment of allComments) {
      if (comment.parentId && commentMap[comment.parentId]) {
        let current = commentMap[comment.parentId];
        while (current && current.parentId && commentMap[current.parentId]) {
          current = commentMap[current.parentId];
        }
        if (current && !current.parentId) {
          current.replies.push(commentMap[comment.id]);
        }
      } else if (!comment.parentId) {
        topLevel.push(commentMap[comment.id]);
      }
    }
    
    topLevel.sort((a, b) => {
      const aTime = a.timestamp?.toDate?.()?.getTime() || 0;
      const bTime = b.timestamp?.toDate?.()?.getTime() || 0;
      return bTime - aTime;
    });
    
    for (const comment of topLevel) {
      if (comment.replies && comment.replies.length > 0) {
        comment.replies.sort((a, b) => {
          const aTime = a.timestamp?.toDate?.()?.getTime() || 0;
          const bTime = b.timestamp?.toDate?.()?.getTime() || 0;
          return aTime - bTime;
        });
      }
    }
    
    if (reset) {
      commentSheetComments = topLevel;
    } else {
      const existingIds = new Set(commentSheetComments.map(c => c.id));
      for (const comment of topLevel) {
        if (!existingIds.has(comment.id)) {
          commentSheetComments.push(comment);
        }
      }
    }
    
    commentSheetLastDoc = snapshot.docs[snapshot.docs.length - 1];
    commentSheetHasMore = snapshot.docs.length === 30;
    
    renderCommentSheetComments();
  } catch (error) {
    console.error('Error loading comments:', error);
    container.innerHTML = `
      <div class="comment-sheet-empty">
        <span class="comment-sheet-empty-icon">❌</span>
        <p>Error loading comments. Please try again.</p>
      </div>
    `;
  }
  
  commentSheetIsLoading = false;
}

function renderCommentSheetComments() {
  const container = document.getElementById('commentSheetBody');
  if (!container) return;
  
  if (commentSheetComments.length === 0) {
    container.innerHTML = `
      <div class="comment-sheet-empty">
        <span class="comment-sheet-empty-icon">💬</span>
        <p>No comments yet. Be the first to comment!</p>
      </div>
    `;
    return;
  }
  
  let html = `<div style="min-width: 100%; width: 100%;">`;
  
  for (const comment of commentSheetComments) {
    html += renderCommentSheetItem(comment);
  }
  
  html += `</div>`;
  
  if (commentSheetHasMore) {
    html += `
      <div style="text-align:center;padding:12px;position:sticky;left:0;">
        <button onclick="loadMoreCommentSheetComments()" style="background:#2a2a4e;border:none;color:#a7a9be;padding:8px 20px;border-radius:20px;cursor:pointer;font-size:0.85rem;">
          Load older comments...
        </button>
      </div>
    `;
  }
  
  container.innerHTML = html;
}

function renderCommentSheetItem(comment) {
  const date = comment.timestamp?.toDate() || new Date();
  const timeStr = date.toLocaleString();
  const isReply = comment.parentId && comment.parentId !== '';
  
  const indent = isReply ? 20 : 0;
  const nameColor = isReply ? '#FFB300' : '#e94560';
  const itemClass = isReply ? 'reply' : 'parent';
  
  let html = `
    <div class="comment-sheet-item ${itemClass}" style="
      padding: ${isReply ? '4px' : '8px'} 0;
      ${isReply ? `margin-left: 20px; border-left: 2px solid #2a2a4e; padding-left: 10px;` : ''}
    ">
      <div class="comment-username">
        <span class="name" style="color:${nameColor};">${escapeHtml(comment.username || 'Anonymous')}</span>
        <span class="time">${timeStr}</span>
      </div>
      <div class="comment-text">${escapeHtml(comment.text)}</div>
      <div class="comment-actions">
        <button class="reply-btn" onclick="setCommentSheetReply('${comment.id}', '${escapeHtml(comment.username || 'Anonymous')}')">↩️ Reply</button>
      </div>
    </div>
  `;
  
  if (comment.replies && comment.replies.length > 0) {
    for (const reply of comment.replies) {
      html += renderCommentSheetItem(reply);
    }
  }
  
  return html;
}

function loadMoreCommentSheetComments() {
  if (currentCommentPostId && !commentSheetIsLoading && commentSheetHasMore) {
    loadCommentSheetComments(currentCommentPostId, currentCommentPostType, false);
  }
}

function setCommentSheetReply(commentId, username) {
  commentSheetReplyingTo = commentId;
  commentSheetReplyingToUsername = username;
  document.getElementById('commentReplyToName').textContent = username;
  document.getElementById('commentReplyToId').value = commentId;
  document.getElementById('commentReplyIndicator').classList.add('show');
  document.getElementById('commentSheetInput').placeholder = `Replying to @${username}...`;
  document.getElementById('commentSheetInput').focus();
}

function cancelCommentSheetReply() {
  commentSheetReplyingTo = null;
  commentSheetReplyingToUsername = '';
  document.getElementById('commentReplyIndicator').classList.remove('show');
  document.getElementById('commentReplyToName').textContent = '';
  document.getElementById('commentReplyToId').value = '';
  document.getElementById('commentSheetInput').placeholder = 'Write a comment...';
}

// ============================================================
// ===== SUBMIT COMMENT =====
// ============================================================

async function submitCommentSheet() {
  const input = document.getElementById('commentSheetInput');
  let text = input.value.trim();
  if (!text) return;
  if (!currentCommentPostId) return;
  
  const submitBtn = document.getElementById('commentSheetSubmit');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Posting...';
  
  try {
    const user = currentUser;
    const userId = user?.uid || 'unknown';
    const username = user?.displayName || 'Anonymous';
    
    const collectionPath = currentCommentPostType === 'feed' ?
      `feed_posts/${currentCommentPostId}/comments` :
      `community_posts/${currentCommentPostId}/comments`;
    
    let parentAuthorId = null;
    let parentUsername = '';
    let parentCommentId = commentSheetReplyingTo || null;
    let finalText = text;
    
    if (commentSheetReplyingTo) {
      try {
        const parentDoc = await db.collection(collectionPath).doc(commentSheetReplyingTo).get();
        if (parentDoc.exists) {
          const parentData = parentDoc.data();
          parentAuthorId = parentData.userId;
          parentUsername = parentData.username || 'someone';
          finalText = `@${parentUsername} ${text}`;
        }
      } catch (e) {
        console.error('Error getting parent comment:', e);
      }
    }
    
    const commentData = {
      username: username,
      text: finalText,
      timestamp: firebase.firestore.FieldValue.serverTimestamp(),
      userId: userId,
      parentId: parentCommentId
    };
    
    const newCommentRef = await db.collection(collectionPath).add(commentData);
    
    logEvent('comment_created', {
      post_id: currentCommentPostId,
      post_type: currentCommentPostType,
      is_reply: !!parentCommentId
    });
    
    if (parentAuthorId && parentAuthorId !== userId && parentAuthorId !== 'unknown') {
      await db.collection('notifications').add({
        type: 'reply',
        from: userId,
        fromName: username,
        to: parentAuthorId,
        message: `@${username} replied to @${parentUsername}: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`,
        read: false,
        time: 'Just now',
        timestamp: firebase.firestore.FieldValue.serverTimestamp(),
        postId: currentCommentPostId,
        commentId: newCommentRef.id,
        parentCommentId: parentCommentId || '',
        replyText: text
      });
    }
    
    const postRef = currentCommentPostType === 'feed' ?
      db.collection('feed_posts').doc(currentCommentPostId) :
      db.collection('community_posts').doc(currentCommentPostId);
    
    await db.runTransaction(async (transaction) => {
      const postDoc = await transaction.get(postRef);
      if (!postDoc.exists) {
        throw new Error('Post does not exist!');
      }
      const currentCount = postDoc.data().commentCount || 0;
      transaction.update(postRef, { commentCount: currentCount + 1 });
    });
    
    const localPost = communityPosts.find(p => p.id === currentCommentPostId);
    if (localPost) {
      localPost.comments = (localPost.comments || 0) + 1;
      localPost.commentCount = (localPost.commentCount || 0) + 1;
    }
    
    const feedPost = feedPosts.find(p => p.id === currentCommentPostId);
    if (feedPost) {
      feedPost.comments = (feedPost.comments || 0) + 1;
      feedPost.commentCount = (feedPost.commentCount || 0) + 1;
    }
    
    if (userId !== 'unknown') {
      await awardPointsForInteraction(userId, currentCommentPostId, 'commenting');
    }
    
    input.value = '';
    input.style.height = 'auto';
    cancelCommentSheetReply();
    
    commentSheetComments = [];
    commentSheetLastDoc = null;
    commentSheetHasMore = true;
    await loadCommentSheetComments(currentCommentPostId, currentCommentPostType, true);
    
    if (!isAdmin) {
      renderMainApp();
      restoreScrollPosition();
    }
    
    showToast('✅ Comment posted! +10 points', true);
  } catch (error) {
    console.error('Error submitting comment:', error);
    showToast('❌ Failed to post comment: ' + error.message, false);
    
    if (typeof Sentry !== 'undefined') {
      Sentry.captureException(error, {
        tags: {
          operation: 'submitComment',
          postId: currentCommentPostId,
          postType: currentCommentPostType,
          isReply: !!commentSheetReplyingTo,
        },
        extra: {
          postId: currentCommentPostId,
          postType: currentCommentPostType,
          isReply: !!commentSheetReplyingTo,
          commentText: text?.substring(0, 100),
          userId: currentUser?.uid,
          errorMessage: error.message,
        },
      });
    }
  }
  
  submitBtn.disabled = false;
  submitBtn.textContent = 'Post';
}

// ============================================================
// ===== LIKE, COMMENT, SHARE =====
// ============================================================

async function sharePost(postId, isCommunity = true) {
  const collection = isCommunity ? 'community_posts' : 'adminPosts';
  const post = isCommunity ?
    communityPosts.find(p => p.id === postId) :
    adminPosts.find(p => p.id === postId);
  
  if (!post) return;
  
  try {
    await db.collection(collection).doc(postId).update({
      shares: firebase.firestore.FieldValue.increment(1)
    });
    
    await awardPointsForInteraction(currentUser?.uid, postId, 'sharing');
    
    logEvent('post_shared', {
      post_id: postId,
      post_type: isCommunity ? 'community' : 'admin'
    });
    
    const shareText = `📢 Check out this post on DHouse!\n\n"${post.content.substring(0, 100)}${post.content.length > 100 ? '...' : ''}"\n\n`;
    const shareUrl = window.location.href;
    
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'DHouse - Reality TV Companion',
          text: shareText,
          url: shareUrl
        });
        showToast('📤 Post shared successfully! +10 points', true);
      } catch (shareError) {
        if (shareError.name !== 'AbortError') {
          console.error('Share error:', shareError);
          await fallbackShare(shareText, shareUrl);
        }
      }
    } else {
      await fallbackShare(shareText, shareUrl);
    }
    
    post.shares = (post.shares || 0) + 1;
    
    if (showFullPostView) {
      renderFullPostView();
    } else {
      renderMainApp();
      restoreScrollPosition();
    }
  } catch (error) {
    console.error('Error sharing post:', error);
    showToast('❌ Failed to share.', false);
  }
}

async function fallbackShare(text, url) {
  try {
    await navigator.clipboard.writeText(`${text}\n${url}`);
    
    const shareOptions = [
      { name: '📱 Copy Link', action: () => navigator.clipboard.writeText(url) },
      { name: '🐦 Twitter', action: () => window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`, '_blank') },
      { name: '💬 WhatsApp', action: () => window.open(`https://wa.me/?text=${encodeURIComponent(text + '\n' + url)}`, '_blank') },
      { name: '📘 Facebook', action: () => window.open(`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}&quote=${encodeURIComponent(text)}`, '_blank') }
    ];
    
    const choice = confirm(
      `📤 Link copied to clipboard!\n\n${text}\n${url}\n\nChoose sharing method:\n• OK = Open share options\n• Cancel = Just copied`
    );
    
    if (choice) {
      const method = prompt(
        `Choose sharing method:\n1. Copy Link\n2. Twitter\n3. WhatsApp\n4. Facebook\n\nEnter number (1-4):`
      );
      
      const index = parseInt(method) - 1;
      if (index >= 0 && index < shareOptions.length) {
        shareOptions[index].action();
      }
    }
    
    showToast('📤 Link copied to clipboard!', true);
  } catch (clipboardError) {
    alert(`📤 Share this post:\n\n${text}\n${url}\n\nPlease copy the text above and share it!`);
  }
}

async function commentPost(postId, isCommunity = true) {
  if (!currentUser) {
    showToast('Please sign in to comment', false);
    return;
  }
  openCommentSheet(postId, isCommunity ? 'community' : 'feed');
}

// ============================================================
// ===== MAIN APP (User) =====
// ============================================================

function renderMainApp() {
  if (isAdmin) {
    renderAdminApp();
    return;
  }
  
  if (showFullPostView && fullPostData) {
    renderFullPostView();
    return;
  }
  
  if (showReplyView && replyViewData) {
    renderReplyView();
    return;
  }
  
  if (viewerType) {
    renderViewer();
    return;
  }
  
  if (showNotificationDetail && selectedNotification) {
    root.innerHTML = renderNotificationDetail();
    return;
  }
  
  if (showSearchScreen) {
    return;
  }
  
  if (showAdsScreen) {
    renderAdsScreen();
    return;
  }
  
  if (showAdDetail && selectedAdDetail) {
    renderAdDetail();
    return;
  }
  
  const tabs = [
    { id: 'feed', icon: '📰' },
    { id: 'community', icon: '👥' },
    { id: 'wordgame', icon: '🎯' },
    { id: 'predictions', icon: '🔮' },
    { id: 'housemates', icon: '🏠' },
    { id: 'notifications', icon: '🔔' }
  ];
  
  let content = '';
  
  switch (activeTab) {
    case 'feed':
      content = renderFeed();
      break;
    case 'community':
      content = renderCommunity();
      break;
    case 'wordgame':
      content = renderWordGame();
      break;
    case 'predictions':
      content = renderPredictions();
      break;
    case 'housemates':
      content = renderHousemates();
      break;
    case 'notifications':
      content = renderNotifications();
      break;
  }
  
  logScreenView(activeTab);
  
  const menuHTML = showMenu ? `
    <div class="side-menu-overlay" onclick="handleMenuOverlayClick()">
      <div class="side-menu" onclick="event.stopPropagation()">
        <div class="side-menu-header">
          <div class="avatar-large">${getUserAvatar(currentUser?.displayName, currentUserProfile?.profilePic)}</div>
          <h3>${currentUser?.displayName || currentUser?.email}</h3>
          <p>${currentUser?.email}</p>
          <p style="color:#FFB300;font-size:0.8rem;">⭐ ${currentUserPoints} points</p>
        </div>
        <div class="side-menu-items">
          <button class="side-menu-item" onclick="loadPage('profile')">👤 Profile</button>
          <button class="side-menu-item" onclick="openAdsScreen()">📢 Advertise</button>
          <button class="side-menu-item" onclick="renderSettingsPage()">⚙️ Settings</button>
          <button class="side-menu-item logout" onclick="handleLogoutWithDialog()">🚪 Logout</button>
        </div>
      </div>
    </div>
  ` : '';
  
  const goTopHTML = showTopButton ? `
    <button onclick="scrollToTop()" class="go-top-btn">⬆</button>
  ` : '';
  
  const showSearchButton = activeTab === 'community';
  
  root.innerHTML = `
    <div class="main-app" id="mainApp">
      <div class="top-bar">
        <div class="top-bar-left">
          <button class="icon-btn" onclick="toggleMenu()">☰</button>
          <span class="app-title">DHouse</span>
        </div>
        <div class="top-bar-right">
          ${showSearchButton ? `<button class="icon-btn" onclick="openSearchScreen()">🔍</button>` : ''}
          <button class="icon-btn" onclick="openNewPostModal()">➕</button>
        </div>
      </div>
      <div class="content-area" id="contentArea" onscroll="handleScroll()">${content}</div>
      <div class="bottom-nav">
        ${tabs.map(tab => `
          <button class="nav-btn ${activeTab === tab.id ? 'active' : ''}" onclick="switchTab('${tab.id}')">
            <span class="nav-icon">${tab.icon}</span>
            ${tab.id === 'notifications' && notificationCount > 0 ? `<span class="notif-badge">${notificationCount}</span>` : ''}
          </button>
        `).join('')}
      </div>
      ${menuHTML}
      ${goTopHTML}
    </div>
  `;
  
  setTimeout(() => {
    setupLazyLoading();
  }, 200);
  
  if (activeTab === 'feed' || activeTab === 'community') {
    setTimeout(scrollToTop, 100);
    setTimeout(restoreScrollPosition, 150);
  }
}

// ============================================================
// ===== TEST SENTRY (Remove after testing) =====
// ============================================================

function testSentry() {
  console.log('🧪 Testing Sentry...');
  
  try {
    throw new Error('🧪 Sentry test - if you see this in Sentry, it\'s working!');
  } catch (error) {
    console.log('📤 Sending test error to Sentry...');
    
    if (typeof Sentry !== 'undefined') {
      Sentry.captureException(error, {
        tags: { test: 'true' },
        extra: {
          timestamp: new Date().toISOString(),
          source: 'manual_test',
        },
      });
      
      showToast('✅ Test error sent to Sentry! Check your Sentry dashboard.', true);
      console.log('✅ Test error sent to Sentry!');
    } else {
      showToast('❌ Sentry not loaded. Check your setup.', false);
      console.error('❌ Sentry not available');
    }
  }
}

window.testSentry = testSentry;

// ============================================================
// ===== LAZY LOADING SETUP =====
// ============================================================

function setupLazyLoading() {
  if (postObserver) {
    postObserver.disconnect();
  }
  
  const options = {
    root: document.getElementById('contentArea'),
    rootMargin: '100px 0px',
    threshold: 0.01
  };
  
  postObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const img = entry.target;
        const dataSrc = img.getAttribute('data-src');
        if (dataSrc) {
          img.src = dataSrc;
          img.removeAttribute('data-src');
          img.onload = function() {
            this.classList.add('loaded');
          };
          img.onerror = function() {
            console.warn('Image failed to load:', dataSrc);
            this.classList.add('loaded');
            this.style.background = '#2a2a4e';
          };
        }
        postObserver.unobserve(img);
      }
    });
  }, options);
  
  const images = document.querySelectorAll('img[data-src]');
  console.log(`🖼️ Found ${images.length} images to lazy load`);
  
  images.forEach(img => {
    postObserver.observe(img);
  });
  
  setTimeout(() => {
    document.querySelectorAll('img[data-src]').forEach(img => {
      const rect = img.getBoundingClientRect();
      const contentArea = document.getElementById('contentArea');
      if (contentArea) {
        const contentRect = contentArea.getBoundingClientRect();
        if (rect.top < contentRect.bottom && rect.bottom > contentRect.top) {
          const dataSrc = img.getAttribute('data-src');
          if (dataSrc) {
            img.src = dataSrc;
            img.removeAttribute('data-src');
            img.onload = function() { this.classList.add('loaded'); };
            img.onerror = function() { this.classList.add('loaded'); };
          }
          postObserver.unobserve(img);
        }
      }
    });
  }, 100);
}

function handleMenuOverlayClick() {
  closeMenu();
}

function closeMenu() {
  showMenu = false;
  renderMainApp();
}

function handleScroll() {
  const contentArea = document.getElementById('contentArea');
  if (contentArea) {
    savedScrollPositions[activeTab] = contentArea.scrollTop;
    
    showTopButton = contentArea.scrollTop > 300;
    const existingBtn = document.querySelector('.go-top-btn');
    if (showTopButton) {
      if (!existingBtn) {
        const btn = document.createElement('button');
        btn.className = 'go-top-btn';
        btn.innerHTML = '⬆';
        btn.onclick = scrollToTop;
        document.querySelector('.main-app').appendChild(btn);
      }
    } else {
      if (existingBtn) {
        existingBtn.remove();
      }
    }
  }
}

function scrollToTop() {
  const contentArea = document.getElementById('contentArea');
  if (contentArea) {
    contentArea.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

function toggleMenu() {
  showMenu = !showMenu;
  renderMainApp();
}

function handleLogoutWithDialog() {
  closeMenu();
  
  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.8);
    z-index: 9999;
    display: flex;
    align-items: center;
    justify-content: center;
  `;
  overlay.innerHTML = `
    <div style="background:#1a1a2e;border-radius:16px;padding:2rem;text-align:center;border:1px solid #2a2a4e;max-width:300px;width:90%;">
      <div style="width:40px;height:40px;border:3px solid #2a2a4e;border-top-color:#e94560;border-radius:50%;animation:spin 1s linear infinite;margin:0 auto 1rem;"></div>
      <p style="color:#fffffe;">Logging out...</p>
    </div>
  `;
  document.body.appendChild(overlay);
  
  auth.signOut().then(() => {
    overlay.remove();
    dataManager.cleanupListeners();
    showToast('Logged out successfully', true);
  }).catch((error) => {
    overlay.remove();
    showToast('Error logging out', false);
    console.error('Logout error:', error);
  });
}

function switchTab(tabId) {
  logEvent('tab_switch', {
    from: activeTab,
    to: tabId
  });
  
  if (showSearchScreen) {
    showSearchScreen = false;
    searchQuery = '';
  }
  saveScrollPosition();
  activeTab = tabId;
  renderMainApp(); // ← This re-renders with the new tab
}

// ============================================================
// ===== MIGRATION SCRIPT =====
// ============================================================

async function migrateData() {
  console.log('🔄 Starting data migration...');
  
  try {
    const counters = {
      'total_posts': communityPosts.length,
      'total_users': allUsers.length,
      'total_likes': 0,
      'total_comments': 0,
    };
    
    for (const [key, value] of Object.entries(counters)) {
      await db.collection('counters').doc(key).set({
        value: value,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      console.log(`✅ Counter ${key}: ${value}`);
    }
    
    console.log('✅ Counters created');
    
    for (const user of allUsers) {
      const userPosts = communityPosts.filter(p => p.userId === user.id);
      const userLikes = userPosts.reduce((sum, p) => sum + (p.likes || 0), 0);
      
      await db.collection('users').doc(user.id).collection('stats').doc('summary').set({
        postCount: userPosts.length,
        likeCount: userLikes,
        commentCount: 0,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    }
    
    console.log('✅ User stats created');
    
    for (const post of communityPosts) {
      await db.collection('community_posts').doc(post.id).collection('stats').doc('summary').set({
        likeCount: post.likes || 0,
        commentCount: post.comments || 0,
        shareCount: post.shares || 0,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    }
    
    console.log('✅ Post stats created');
    console.log('🎉 Migration complete!');
    
  } catch (error) {
    console.error('Migration error:', error);
  }
}

window.migrateData = migrateData;

function togglePostExpand(postId) {
  expandedPosts[postId] = !expandedPosts[postId];
  renderMainApp();
  restoreScrollPosition();
}

// ============================================================
// ===== MODAL FUNCTIONS =====
// ============================================================

function openNewPostModal() {
  console.log('📝 Opening new post modal...');
  
  newPostText = '';
  selectedImageFiles = [];
  isUploading = false;
  uploadProgress = 0;
  
  const avatarEl = document.getElementById('modalUserAvatar');
  if (avatarEl) {
    avatarEl.textContent = currentUser?.displayName?.[0] || '👤';
  }
  
  const textarea = document.getElementById('newPostTextArea');
  if (textarea) textarea.value = '';
  
  const tagInput = document.getElementById('tagInput');
  if (tagInput) {
    tagInput.value = '';
    tagInput.placeholder = 'Add mentions (e.g., @username @another)';
    tagInput.oninput = null;
  }
  
  updateModalPreviewUI();
  
  document.getElementById('newPostModal').style.display = 'flex';
  console.log('📝 Modal opened');
}

function closeNewPostModal() {
  console.log('📝 Closing modal');
  document.getElementById('newPostModal').style.display = 'none';
}

function updateModalPreviewUI() {
  console.log('🔄 updateModalPreviewUI called');
  console.log('📸 selectedImageFiles length:', selectedImageFiles.length);
  
  const imagesContainer = document.getElementById('imagesPreviewGrid');
  const countInfo = document.getElementById('imageCountInfo');
  const photoCount = document.getElementById('photoCount');
  const progressContainer = document.getElementById('uploadProgressContainer');
  const progressFill = document.getElementById('uploadProgressFill');
  const progressText = document.getElementById('uploadProgressText');
  
  if (imagesContainer) {
    if (selectedImageFiles.length === 0) {
      imagesContainer.innerHTML = '';
      if (countInfo) countInfo.textContent = `0 / ${MAX_IMAGES} images selected`;
      if (photoCount) photoCount.textContent = '0';
    } else {
      let html = '';
      for (let i = 0; i < selectedImageFiles.length; i++) {
        const img = selectedImageFiles[i];
        html += `
          <div class="preview-image-item">
            <img src="${img.preview}" alt="Preview ${i + 1}">
            <span class="preview-image-number">${i + 1}</span>
            <button class="remove-image-btn" onclick="removeModalImage(${i})">✕</button>
          </div>
        `;
      }
      imagesContainer.innerHTML = html;
      if (countInfo) countInfo.textContent = `${selectedImageFiles.length} / ${MAX_IMAGES} images selected`;
      if (photoCount) photoCount.textContent = selectedImageFiles.length;
    }
  }
  
  if (progressContainer) {
    if (isUploading) {
      progressContainer.style.display = 'block';
      if (progressFill) progressFill.style.width = uploadProgress + '%';
      if (progressText) progressText.textContent = uploadProgress + '%';
    } else {
      progressContainer.style.display = 'none';
      if (progressFill) progressFill.style.width = '0%';
      if (progressText) progressText.textContent = '0%';
    }
  }
}

function handleMediaUpload(event) {
  console.log('📎 Media upload triggered');
  const files = event.target.files;
  
  let imageFiles = [];
  
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    
    if (file.size > MAX_UPLOAD_SIZE) {
      alert(`${file.name} is larger than 3MB.`);
      continue;
    }
    
    if (file.type.startsWith('image/')) {
      imageFiles.push(file);
    }
  }
  
  if (imageFiles.length > 0) {
    const remaining = MAX_IMAGES - selectedImageFiles.length;
    const totalImagesToAdd = Math.min(imageFiles.length, remaining);
    
    if (imageFiles.length > remaining) {
      alert(`You can only upload ${remaining} more image(s). Maximum ${MAX_IMAGES} allowed.`);
    }
    
    let loadedCount = 0;
    const imagesToProcess = imageFiles.slice(0, remaining);
    
    for (let i = 0; i < imagesToProcess.length; i++) {
      const file = imagesToProcess[i];
      const reader = new FileReader();
      reader.onload = function(e) {
        selectedImageFiles.push({
          file: file,
          preview: e.target.result,
          name: file.name,
          size: file.size,
          type: file.type
        });
        loadedCount++;
        if (loadedCount === imagesToProcess.length) {
          updateModalPreviewUI();
        }
      };
      reader.readAsDataURL(file);
    }
  }
  
  event.target.value = '';
}

function removeModalImage(index) {
  selectedImageFiles.splice(index, 1);
  updateModalPreviewUI();
}

async function submitModalPost() {
  console.log('📝 Submitting post...');
  const textarea = document.getElementById('newPostTextArea');
  const tagInput = document.getElementById('tagInput');
  const postText = textarea ? textarea.value : '';
  const tagInputValue = tagInput ? tagInput.value : '';
  
  if (!postText.trim() && selectedImageFiles.length === 0) {
    alert('Please write something or add an image!');
    return;
  }
  
  if (selectedImageFiles.length > 0) {
    for (const fileObj of selectedImageFiles) {
      let file = fileObj.file || fileObj;
      if (file.size > MAX_UPLOAD_SIZE) {
        alert(`${file.name} is larger than 3MB. Please select a smaller image.`);
        return;
      }
    }
  }
  
  let tags = [];
  if (tagInputValue) {
    const tagMatches = tagInputValue.match(/@([a-z0-9_]+)/gi);
    if (tagMatches) {
      tags = tagMatches.map(t => t.substring(1).toLowerCase());
    }
  }
  
  isUploading = true;
  uploadProgress = 0;
  
  const progressContainer = document.getElementById('uploadProgressContainer');
  if (progressContainer) {
    progressContainer.style.display = 'block';
  }
  const fill = document.getElementById('uploadProgressFill');
  const text = document.getElementById('uploadProgressText');
  const statusText = document.getElementById('uploadStatusText');
  if (fill) fill.style.width = '0%';
  if (text) text.textContent = '0%';
  if (statusText) statusText.textContent = 'Starting upload...';
  
  updateModalPreviewUI();
  
  let imageUrls = [];
  let uploadFailed = false;
  let failedFileNames = [];
  
  if (selectedImageFiles.length > 0) {
    const totalImages = selectedImageFiles.length;
    
    for (let i = 0; i < totalImages; i++) {
      try {
        const fileObj = selectedImageFiles[i];
        let file = fileObj.file || fileObj;
        
        if (!file || !(file instanceof Blob) || file.size === 0) {
          uploadFailed = true;
          failedFileNames.push(fileObj.name || `Image ${i + 1}`);
          continue;
        }
        
        if (statusText) {
          statusText.textContent = `Uploading image ${i + 1} of ${totalImages}...`;
          statusText.style.color = '#a7a9be';
        }
        
        const compressed = await compressImage(file, 800, 0.7);
        
        const urls = await uploadPostImages([compressed], {
          onRetry: (fileIndex, attempt, delay, error) => {
            if (statusText) {
              statusText.textContent = `⏳ Retry ${attempt}/${3} for image ${fileIndex}...`;
              statusText.style.color = '#FFB300';
            }
            console.log(`🔄 Image ${fileIndex}: Retry ${attempt}/${3} due to:`, error.message);
          },
          onFileProgress: (current, total) => {
            const percent = Math.round((current / total) * 100);
            if (fill) fill.style.width = percent + '%';
            if (text) text.textContent = percent + '%';
          },
        });
        
        if (urls && urls.length > 0 && urls[0]) {
          imageUrls.push(urls[0]);
          logEvent('image_upload', {
            success: true,
            file_size: file.size,
            file_type: file.type,
            post_type: 'community'
          });
        } else {
          uploadFailed = true;
          failedFileNames.push(fileObj.name || `Image ${i + 1}`);
        }
      } catch (error) {
        console.error(`Image ${i + 1} upload failed:`, error);
        uploadFailed = true;
        failedFileNames.push(fileObj.name || `Image ${i + 1}`);
        
        if (typeof Sentry !== 'undefined') {
          Sentry.captureException(error, {
            tags: {
              imageIndex: i + 1,
              totalImages: totalImages,
              postType: 'community',
            },
            extra: {
              fileName: fileObj?.name || 'unknown',
              fileSize: fileObj?.size || 0,
              errorMessage: error.message,
            },
          });
        }
        
        logEvent('image_upload', {
          success: false,
          error: error.message || 'Unknown error',
          post_type: 'community'
        });
      }
      
      uploadProgress = Math.round(((i + 1) / totalImages) * 90);
      if (fill) fill.style.width = uploadProgress + '%';
      if (text) text.textContent = uploadProgress + '%';
    }
  }
  
  if (uploadFailed && selectedImageFiles.length > 0) {
    const failedList = failedFileNames.join('\n• ');
    alert(`❌ Upload failed for:\n• ${failedList}\n\nYour images remain selected. Please check your internet connection and try again.`);
    
    if (imageUrls.length > 0) {
      await deleteR2Images(imageUrls);
    }
    
    isUploading = false;
    uploadProgress = 0;
    if (progressContainer) {
      progressContainer.style.display = 'none';
    }
    if (fill) fill.style.width = '0%';
    if (text) text.textContent = '0%';
    if (statusText) statusText.textContent = '';
    updateModalPreviewUI();
    return;
  }
  
  if (statusText) {
    statusText.textContent = 'Saving post...';
    statusText.style.color = '#4CAF50';
  }
  if (fill) fill.style.width = '95%';
  if (text) text.textContent = '95%';
  
  const username = currentUser?.displayName || currentUser?.email || 'Anonymous';
  const userhandle = '@' + (currentUser?.displayName?.toLowerCase() || 'user');
  
  const postData = {
    user: username,
    username: userhandle,
    userId: currentUser?.uid || '',
    content: postText,
    tags: tags,
    images: imageUrls
  };
  
  let postRef = null;
  try {
    postRef = await db.collection('community_posts').add({
      username: postData.user,
      user: postData.user,
      userId: postData.userId || '',
      content: postData.content,
      likes: 0,
      commentCount: 0,
      shares: 0,
      liked: false,
      tags: postData.tags || [],
      imageUrls: postData.images || [],
      emojiReactions: {},
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    
    if (postRef && postRef.id) {
      await incrementCounter('total_posts', 1);
      await incrementCounter(`user_${currentUser.uid}_posts`, 1);
      await updateUserStats(currentUser.uid, {
        lastPostAt: new Date().toISOString(),
      });
    }
    
    logEvent('post_created', {
      has_images: imageUrls.length > 0,
      image_count: imageUrls.length,
      char_count: postText.length,
      has_tags: tags.length > 0,
      tag_count: tags.length,
      post_id: postRef.id
    });
    
    dataManager.invalidateCache('community_posts');
    
  } catch (error) {
    console.error('Error adding post:', error);
    
    if (typeof Sentry !== 'undefined') {
      Sentry.captureException(error, {
        tags: {
          hasImages: imageUrls.length > 0,
          imageCount: imageUrls.length,
          hasTags: tags.length > 0,
          tagCount: tags.length,
        },
        extra: {
          postText: postText?.substring(0, 200),
          tags: tags,
          userId: currentUser?.uid,
          imageUrls: imageUrls,
          errorMessage: error.message,
        },
      });
    }
    
    if (imageUrls.length > 0) {
      await deleteR2Images(imageUrls);
    }
    
    isUploading = false;
    uploadProgress = 0;
    if (progressContainer) {
      progressContainer.style.display = 'none';
    }
    alert('❌ Failed to publish post. Please try again.');
    updateModalPreviewUI();
    return;
  }
  
  if (fill) fill.style.width = '100%';
  if (text) text.textContent = '100%';
  if (statusText) {
    statusText.textContent = '✅ Post published!';
    statusText.style.color = '#4CAF50';
  }
  
  if (postRef && postRef.id && tags.length > 0) {
    try {
      const postId = postRef.id;
      const usersSnapshot = await db.collection('users').get();
      const allUsersMap = {};
      usersSnapshot.forEach((doc) => {
        const userData = doc.data();
        allUsersMap[userData.username?.toLowerCase()] = {
          id: doc.id,
          username: userData.username
        };
      });
      
      for (const tag of tags) {
        const tagLower = tag.toLowerCase();
        if (allUsersMap[tagLower]) {
          const foundUser = allUsersMap[tagLower];
          if (foundUser.id !== currentUser.uid) {
            try {
              await addNotification({
                type: 'tag',
                from: currentUser.uid,
                fromName: username,
                to: foundUser.id,
                message: `${username} tagged you in a post: "${postText.substring(0, 50)}${postText.length > 50 ? '...' : ''}"`,
                postId: postId
              });
            } catch (notifError) {
              console.error('Failed to send notification to:', foundUser.id, notifError);
            }
          }
        }
      }
    } catch (error) {
      console.error('Error processing tags:', error);
      
      if (typeof Sentry !== 'undefined') {
        Sentry.captureException(error, {
          tags: {
            operation: 'tag_notification',
            postId: postRef?.id,
          },
          extra: {
            tags: tags,
            userId: currentUser?.uid,
          },
        });
      }
    }
  }
  
  isUploading = false;
  uploadProgress = 0;
  if (progressContainer) {
    setTimeout(() => {
      progressContainer.style.display = 'none';
    }, 1500);
  }
  
  selectedImageFiles = [];
  closeNewPostModal();
  showToast('✅ Post published successfully!', true);
  renderMainApp();
}

// ============================================================
// ===== AUTH STATE LISTENER =====
// ============================================================

auth.onAuthStateChanged(async (user) => {
  if (user && user.emailVerified) {
    currentUser = user;
    
    if (typeof Sentry !== 'undefined') {
      Sentry.setUser({
        id: user.uid,
        email: user.email,
        username: user.displayName || user.email?.split('@')[0],
      });
      console.log('📊 Sentry user context set for:', user.email);
    }
    
    setUserProperties({
      user_id: user.uid,
      email_domain: user.email ? user.email.split('@')[1] : 'unknown',
    });
    
    isAdmin = await isUserAdmin(user);
    
    if (await isMaintenanceMode() && !isAdmin) {
      alert('🔧 DHouse is currently under maintenance. Please check back later.');
      await auth.signOut();
      return;
    }
    
    try {
      const doc = await db.collection('users').doc(user.uid).get();
      if (doc.exists) {
        currentUserProfile = doc.data();
        currentUserPoints = doc.data().totalPoints || 0;
        profileDataCache = doc.data();
      } else {
        await db.collection('users').doc(user.uid).set({
          username: user.displayName || user.email.split('@')[0],
          email: user.email,
          totalPoints: 0,
          accuracy: 0,
          predictions: 0,
          correctPredictions: 0,
          profilePic: null,
          createdAt: new Date()
        });
        currentUserProfile = {
          username: user.displayName || user.email.split('@')[0],
          email: user.email,
          totalPoints: 0,
          accuracy: 0,
          predictions: 0,
          correctPredictions: 0,
          profilePic: null
        };
        profileDataCache = currentUserProfile;
        currentUserPoints = 0;
      }
    } catch (e) {
      console.log('Profile fetch error:', e);
    }
    
    loadUserReactions();
    await loadFlaggedPostsStatus();
    
    // Enable persistence and load data
    if (!persistenceEnabled) {
      await enableFirestorePersistence();
    }
    
    await loadPostsOptimized();
    
    if (isAdmin) {
      await loadAllUsers();
      renderAdminApp();
    } else {
      renderMainApp();
    }
  } else if (user) {
    currentUser = user;
    
    if (typeof Sentry !== 'undefined') {
      Sentry.setUser(null);
    }
    showAuth('login');
    alert('📧 Please verify your email. Check spam folder!');
  } else {
    currentUser = null;
    currentUserProfile = null;
    isAdmin = false;
    profileDataCache = null;
    
    if (typeof Sentry !== 'undefined') {
      Sentry.setUser(null);
    }
    
    dataManager.cleanupListeners();
    dataManager.invalidateAllCache();
    
    if (window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone) {
      showAuth('login');
    } else {
      root.innerHTML = renderLanding();
    }
  }
});

// ============================================================
// ===== SERVICE WORKER REGISTRATION =====
// ============================================================

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then((registration) => {
        console.log('✅ Service worker registered');
        
        setInterval(() => {
          registration.update();
          console.log('🔄 Checking for service worker updates...');
        }, 60 * 60 * 1000);
      })
      .catch((error) => {
        console.log('❌ Service worker registration failed:', error);
      });
    
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      console.log('🔄 Service worker controller changed');
      showToast('🔄 New version available! Refresh to update.', true);
    });
  });
}

// ============================================================
// ===== SERVICE WORKER UPDATE NOTIFICATION =====
// ============================================================

if (navigator.serviceWorker) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'NEW_VERSION') {
      showToast('🔄 New version available! Refresh to update.', true);
    }
  });
}

function checkForUpdates() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistration().then((registration) => {
      if (registration) {
        registration.update();
        showToast('🔄 Checking for updates...', true);
      }
    });
  }
}

window.checkForUpdates = checkForUpdates;

// ============================================================
// ===== COUNTER FUNCTIONS =====
// ============================================================

async function incrementCounter(counterName, amount = 1) {
  try {
    const counterRef = db.collection('counters').doc(counterName);
    await counterRef.set({
      value: firebase.firestore.FieldValue.increment(amount),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  } catch (error) {
    console.error('Error incrementing counter:', error);
  }
}

async function getCounterValue(counterName) {
  try {
    const doc = await db.collection('counters').doc(counterName).get();
    return doc.exists ? doc.data().value || 0 : 0;
  } catch (error) {
    console.error('Error getting counter:', error);
    return 0;
  }
}

async function updateUserStats(userId, stats) {
  try {
    const userStatsRef = db.collection('users').doc(userId).collection('stats').doc('summary');
    await userStatsRef.set({
      ...stats,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  } catch (error) {
    console.error('Error updating user stats:', error);
  }
}

// ============================================================
// ===== MAKE FUNCTIONS GLOBAL =====
// ============================================================

window.openNewPostModal = openNewPostModal;
window.closeNewPostModal = closeNewPostModal;
window.handleMediaUpload = handleMediaUpload;
window.removeModalImage = removeModalImage;
window.submitModalPost = submitModalPost;
window.openNotificationDetail = openNotificationDetail;
window.closeNotificationDetail = closeNotificationDetail;
window.getNotificationById = getNotificationById;
window.copyToClipboard = copyToClipboard;
window.sendAdminBroadcastToAll = sendAdminBroadcastToAll;
window.sendAdminBroadcastToSingle = sendAdminBroadcastToSingle;
window.sendAdminBroadcastToList = sendNotificationToList;
window.getAdminPostById = getAdminPostById;
window.switchAdminView = switchAdminView;
window.deleteUserAccount = deleteUserAccount;
window.loadAllUsers = loadAllUsers;
window.toggleFlagPost = toggleFlagPost;
window.deleteUserPost = deleteUserPost;
window.addEmojiReaction = addEmojiReaction;
window.closeEmojiPicker = closeEmojiPicker;
window.showEmojiPicker = showEmojiPicker;
window.addFeedEmojiReaction = addFeedEmojiReaction;
window.showFeedEmojiPicker = showFeedEmojiPicker;
window.loadPage = loadPage;
window.renderProfilePage = renderProfilePage;
window.updateProfilePic = updateProfilePic;
window.loadFlaggedPostsForAdmin = loadFlaggedPostsForAdmin;
window.resolveFlaggedPost = resolveFlaggedPost;
window.showToast = showToast;
window.submitCommentSheet = submitCommentSheet;
window.closeCommentSheet = closeCommentSheet;
window.setCommentSheetReply = setCommentSheetReply;
window.cancelCommentSheetReply = cancelCommentSheetReply;
window.loadMoreCommentSheetComments = loadMoreCommentSheetComments;
window.togglePostMenu = togglePostMenu;
window.openFullPostView = openFullPostView;
window.closeFullPostView = closeFullPostView;
window.openReplyView = openReplyView;
window.closeReplyView = closeReplyView;
window.submitReplyView = submitReplyView;
window.sharePost = sharePost;
window.likeCommunityPost = likeCommunityPost;
window.likeFeedPost = likeFeedPost;
window.addReactionToFeedPost = addReactionToFeedPost;
window.commentFeedPost = commentFeedPost;
window.shareFeedPost = shareFeedPost;
window.submitWordGameAnswer = submitWordGameAnswer;
window.toggleAdminFeedOptions = toggleAdminFeedOptions;
window.submitAdminFeedPost = submitAdminFeedPost;
window.submitAdminWordGame = submitAdminWordGame;
window.viewWordSubmissions = viewWordSubmissions;
window.sendMessageToWordSubmissions = sendMessageToWordSubmissions;
window.closeMenu = closeMenu;
window.handleLogoutWithDialog = handleLogoutWithDialog;
window.toggleMenu = toggleMenu;
window.switchTab = switchTab;
window.togglePostExpand = togglePostExpand;
window.voteOnPoll = voteOnPoll;
window.commentPost = commentPost;
window.deleteWordGame = deleteWordGame;
window.openFullPostViewFromNotification = openFullPostViewFromNotification;
window.openReplyViewFromNotification = openReplyViewFromNotification;
window.validateUsername = validateUsername;
window.openSearchScreen = openSearchScreen;
window.closeSearchScreen = closeSearchScreen;
window.handleSearch = handleSearch;
window.renderSettingsPage = renderSettingsPage;
window.toggleNotification = toggleNotification;
window.toggleAutoPlay = toggleAutoPlay;
window.setImageQuality = setImageQuality;
window.clearCache = clearCache;
window.showHelp = showHelp;
window.reportProblem = reportProblem;
window.sendFeedback = sendFeedback;
window.viewPrivacy = viewPrivacy;
window.submitFeedback = submitFeedback;
window.loadAdminFeedback = loadAdminFeedback;
window.markFeedbackRead = markFeedbackRead;
window.markFeedbackResolved = markFeedbackResolved;
window.deleteFeedback = deleteFeedback;
window.addHousemate = addHousemate;
window.deleteHousemate = deleteHousemate;
window.openHousemateDetail = openHousemateDetail;
window.closeHousemateDetail = closeHousemateDetail;
window.submitAdminHousemate = submitAdminHousemate;
window.previewAdminHousemateImage = previewAdminHousemateImage;
window.toggleHousemateStatus = toggleHousemateStatus;
window.submitPrediction = submitPrediction;
window.submitAdminPrediction = submitAdminPrediction;
window.setAdminCorrectAnswer = setAdminCorrectAnswer;
window.viewPredictionUsers = viewPredictionUsers;
window.closePredictionUsersModal = closePredictionUsersModal;
window.openAdsScreen = openAdsScreen;
window.closeAdsScreen = closeAdsScreen;
window.openAdDetail = openAdDetail;
window.closeAdDetail = closeAdDetail;
window.openCreateAdModal = openCreateAdModal;
window.closeCreateAdModal = closeCreateAdModal;
window.previewAdImage = previewAdImage;
window.removeAdImage = removeAdImage;
window.updateAdImpressionCount = updateAdImpressionCount;
window.submitAdRequest = submitAdRequest;
window.approveAd = approveAd;
window.rejectAd = rejectAd;
window.deleteAd = deleteAd;
window.verifyAdPayment = verifyAdPayment;
window.showPaymentModal = showPaymentModal;
window.closePaymentModal = closePaymentModal;
window.copyUniqueCode = copyUniqueCode;
window.loadMoreCommunityPosts = loadMoreCommunityPosts;
window.loadMoreFeedPosts = loadMoreFeedPosts;
window.refreshAllData = refreshAllData;

console.log('🏠 DHouse app loaded with Firestore!');
console.log('✅ All features loaded successfully!');
console.log('✅ Optimized data loading with caching enabled!');
console.log('🚀 Ready for production!');