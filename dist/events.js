"use strict";
/**
 * Typed event bus for internal sweech events
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.sweechEvents = exports.SweechEventBus = void 0;
exports.emitEvent = emitEvent;
const node_events_1 = require("node:events");
class SweechEventBus extends node_events_1.EventEmitter {
    emit(event, data) {
        return super.emit(event, data);
    }
    on(event, listener) {
        return super.on(event, listener);
    }
    once(event, listener) {
        return super.once(event, listener);
    }
    off(event, listener) {
        return super.off(event, listener);
    }
}
exports.SweechEventBus = SweechEventBus;
/** Singleton event bus for the sweech process */
exports.sweechEvents = new SweechEventBus();
/**
 * Convenience helper — emit a typed event on the singleton bus.
 */
function emitEvent(name, data) {
    return exports.sweechEvents.emit(name, data);
}
