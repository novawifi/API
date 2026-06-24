const EventEmitter = require("events");
const cache = require("./cache");

const events = new EventEmitter();

function notifyPaymentChanged(payment, action = "upsert") {
    const platformID = payment?.platformID;
    if (!platformID) return;

    cache.delPrefix(`main:payments:today:${platformID}`);
    cache.delPrefix(`main:search:${platformID}:payments:`);
    events.emit("payment", {
        platformID,
        action,
        payment,
        at: new Date().toISOString(),
    });
}

function notifyUserChanged(user, action = "upsert") {
    const platformID = user?.platformID;
    if (!platformID) return;

    cache.delPrefix(`main:codes:today:${platformID}:`);
    cache.delPrefix(`main:search:${platformID}:users:`);
    events.emit("user", {
        platformID,
        action,
        user,
        at: new Date().toISOString(),
    });
}

module.exports = {
    events,
    notifyPaymentChanged,
    notifyUserChanged,
};
