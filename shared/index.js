// Convenience barrel — apps may also `require('@yemigo/shared/<module>')` directly.
module.exports = {
    firestoreAdmin: require('./firestore-admin'),
    redisClient: require('./redis-client'),
    sentryInit: require('./sentry-init'),
};
