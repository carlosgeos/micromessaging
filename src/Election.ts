// TODO: Integrate this file into Messaging.ts

import { Messaging } from './Messaging';
import { Logger } from 'sw-logger';

export class Election {

    static DEFAULT_TIMEOUT: number = 30 * 1000;
    public TIMEOUT: number = Election.DEFAULT_TIMEOUT;
    private _messaging: Messaging;

    public leaderId: string;
    private _lastLeaderSync: Date;

    private _wasLeader = false;

    constructor(messaging: Messaging, logger: Logger) {
        this._messaging = messaging;
    }

    /**
     * Sets the last date the leader was seen on the PeerStat messages
     * and returns null. Otherwise (no param), returns the Date object
     * or undefined
     */
    public leaderSeen(date?: Date) {
        if (!date) {
            return this._lastLeaderSync;
        }
        this._lastLeaderSync = date;
    }

    /**
     * Starts an election process. This process will try to become the
     * leader before everyone else, when the exclusive queue (lock) is
     * free
     */
    public async start() {
        if (!this._messaging.isConnected()) {
            return;
        }
        await this._messaging.assertLeader();
    }

    /**
     * Returns true if there is a leader change.
     * @param prevLeader The previous leader
     */
    public leaderChange(prevLeader: string) {
        return this.leaderId != null || this.leaderId !== prevLeader;
    }


    /**
     * Emits the leader.stepUp and leader.stepDown events if needed
     */
    public notifyLeader() {
        if (!this._messaging.isConnected()) {
            return;
        }
        this._messaging.eventEmitter.emit('leader', {leaderId: this.leaderId});
        if (this.leaderId === this._messaging.serviceId && !this._wasLeader) {
            console.log(this._messaging.serviceId, 'emitting leader.stepUp');
            this._wasLeader = true;
            this._messaging.eventEmitter.emit('leader.stepUp', {leaderId: this.leaderId});
        }
        if (this.leaderId !== this._messaging.serviceId && this._wasLeader) {
            console.log(this._messaging.serviceId, 'emitting leader.stepDown');
            this._wasLeader = false;
            this._messaging.eventEmitter.emit('leader.stepDown', {leaderId: this.leaderId});
        }
    }
}
