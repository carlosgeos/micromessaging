import { pull } from 'lodash';
import { CustomError, Logger } from 'sw-logger';
import * as v4 from 'uuid/v4';
import { AMQPLatency } from './AMQPLatency';
import { Election } from './Election';
import { MessageHandler, ReturnHandler, Uptime } from './Interfaces';
import { Message } from './Message';
import { Messaging } from './Messaging';
import { isNullOrUndefined, Utils } from './Utils';
import MemoryUsage = NodeJS.MemoryUsage;
import Timer = NodeJS.Timer;

export class PeerStatus {

    public topologyReady: boolean = false;
    private _amqpLatency: AMQPLatency;
    private _election: Election;
    private _foreignBindings: Map<string, ReturnHandler> = new Map<string, ReturnHandler>();
    private _foreignListeners: Map<string, MessageHandler[]> = new Map<string, MessageHandler[]>();
    private _foreignOngoingAsync: Promise<any>;
    private _isActive: boolean = false;
    private _latency: number;
    private _listenersBinding: Promise<ReturnHandler | void>[] = [];
    private _logger: Logger;
    private _messaging: Messaging;
    private _ongoingPublish: boolean = false;
    private _peers: Map<string, PeerStat>;
    private _proxies: Array<(message: Message<PeerStat>) => void> = [];
    private _timer: Timer;

    constructor(messaging: Messaging, logger: Logger) {
        this._messaging = messaging;
        this._amqpLatency = messaging.amqpLatency;
        this._election = messaging.election;
        this._logger = logger;
        this._peers = new Map();
        this._listenersBinding.push(
            this._messaging.listen(this._messaging.internalExchangeName, 'peer.alive', (m: Message<PeerStat>) => {
                this._peerStatusHandler(m);
            }).catch(e => this._messaging.reportError(e)),
            this._messaging.listen(this._messaging.internalExchangeName, 'peer.alive.req', (m) => {
                this._logger.debug('Received peer.alive.req', m.originalMessage());
                this._publishAlive();
            }).catch(e => this._messaging.reportError(e)),
        );
    }

    public async getStatus(targetService: string): Promise<PeerStat[]> {
        return new Promise<PeerStat[]>(async (resolve, reject) => {
            const peers: Map<string, PeerStat> = new Map();
            let cancelTimer = false,
            localTimer: Timer;

            const context = v4();

            const messageHandler = (message: Message<PeerStat>) => {
                message.body.lastSeen = new Date();
                this._logger.debug('getStatus request got an answer', message.body);
                peers.set(message.body.id, message.body);
                this._logger.debug('peers.size', peers.size, message.body.knownPeers);
                if (peers.size > 1 && peers.size === message.body.knownPeers) {
                    cancelTimer = true;
                    if (!isNullOrUndefined(localTimer)) {
                        clearTimeout(localTimer);
                    }
                    this.stopListenOrProxy(targetService, messageHandler).catch(e => this._messaging.reportError(e));
                    resolve(Array.from(peers.values()));
                }
            };

            if (targetService !== this._messaging.serviceName) {
                await this.listenOrProxy(targetService, 'peer.alive', messageHandler);
            } else {
                this._proxies.push(messageHandler);
            }

            await this._messaging.emit(`${Messaging.internalExchangePrefix}.${targetService}`, 'peer.alive.req', undefined, undefined, {onlyIfConnected: true});

            this._amqpLatency.benchmark(true).then((latency) => {
                latency = Math.round(latency) * 6;
                if (cancelTimer) {
                    return;
                }
                localTimer = setTimeout(() => {
                    if (cancelTimer) {
                        return;
                    }
                    // This avoid having getStatus hanging forever...
                    this.stopListenOrProxy(targetService, messageHandler).catch(e => this._messaging.reportError(e));
                    peers.size > 0 ?
                        resolve(Array.from(peers.values())) :
                        reject(new CustomError('notFound', `No peers found for service ${targetService} within benchmarkLatency (hence at least ${latency}ms)`));
                }, Math.max(latency, 1000));
            });
        });
    }

    /**
     * Starts the process of knowing about peers and the system topology.
     */
    public start() {
        if (this._isActive) {
            return;
        }
        this._logger.log(`${this._messaging.serviceId} start peer alive`);
        this._isActive = true;
        this._amqpLatency.benchmark(true)
            .then(l => {
                this._latency = l * 2;
                this._logger.debug('latency known as: ' + this._latency);
            })
            .catch(e => this._messaging.reportError(e));

        Promise.all(this._listenersBinding).then(() => this._keepAlive());
    }

    /**
     * Stops the timers
     */
    public stop() {
        this._isActive = false;
        clearTimeout(this._timer);
    }

    private async _keepAlive() {
        console.log(this._messaging.serviceId, 'keeping alive...');
        if (this._election.TIMEOUT / 3 < 10) {
            this._logger.warn('electionTimeoutTooSmall', 'Election timeout should be at least 10ms');
        }
        if (this._timer != null) {
            clearTimeout(this._timer);
            this._timer = null;
        }
        // Security mechanic in case there is no leader
        if ((this._election.leaderSeen() == null ||
             this._election.leaderSeen().valueOf() < (Date.now() - 60000)) &&
            !this._messaging.ongoingLeaderDiscovery) {
            try {
                this._messaging.ongoingLeaderDiscovery = true;
                await this._election.start();
                this._messaging.ongoingLeaderDiscovery = false;
                console.log(this._messaging.serviceId, 'election has finished');
            } catch (e) {
                console.log(this._messaging.serviceId, 'ERROR: peer status');
            } finally {
                this._messaging.ongoingLeaderDiscovery = false;
            }
        } else {
            console.log(this._messaging.serviceId, 'no need for election... why? lets see:');
            console.log(this._messaging.serviceId, 'leaderSeen is', this._election.leaderSeen());
            console.log(this._messaging.serviceId, 'ongoingLeaderDisc is', this._messaging.ongoingLeaderDiscovery);
        }



        this._publishAlive().catch(e => this._messaging.reportError(e));
        // Keep alive recurrent job
        this._timer = setTimeout(() => {
            this._keepAlive().catch(e => this._messaging.reportError(e));
        }, Math.max(Math.floor(this._election.TIMEOUT / 3), 10));
    }

    private _peerStatusHandler(message: Message<PeerStat>) {
        this._proxies.forEach(fn => fn(message));
        if (!this._isActive) {
            return;
        }
        this._logger.log(`${this._messaging.serviceId} received a peer alive message`, message.body);
        if (message.body.isMaster) {
            this._logger.log(`Leader seen ${message.body.id} at ${new Date().toISOString()}`);
            this._election.leaderSeen(new Date());
            console.log(this._messaging.serviceId, 'leader info received, checking now !');
            const prevLeader = this._election.leaderId;
            this._election.leaderId = message.body.id;
            console.log(this._messaging.serviceId, 'leader is read as:', message.body.leaderId);
            if (this._election.leaderChange(prevLeader)) {
                this._election.notifyLeader();
            }

            this._election.leaderId = message.body.id;
        }
        // Add a timestamp for this received PeerStat message
        message.body.lastSeen = new Date();
        this._peers.set(message.body.id, message.body);
        // Cleanup: check for dead peers
        this._peers.forEach((stat: PeerStat, peerId: string) => {
            this._removeDeadPeer(stat, peerId);
        });
        // if (this._peers.size > peerSize) {
        //     this._keepAlive().catch(e => this._messaging.reportError(e));
        // }
    }

    private async _publishAlive() {
        if (this._ongoingPublish) {
            return;
        }
        this._ongoingPublish = true;
        await this._messaging.emit<PeerStat>(this._messaging.internalExchangeName, 'peer.alive', {
            id: this._messaging.serviceId,
            name: this._messaging.serviceName,
            isReady: this._messaging.isReady(),
            isMaster: this._messaging.serviceId === this._election.leaderId,
            elapsedMs: this._messaging.getUptime().elapsedMs,
            startedAt: this._messaging.getUptime().startedAt,
            leaderId: this._election.leaderId,
            memoryUsage: process.memoryUsage(),
            knownPeers: this._peers.size + (this._peers.size === 0 ? 1 : 0),
        }, undefined, {onlyIfConnected: true});
        this._ongoingPublish = false;
        this._logger.log(`Published I'm still alive`);
    }

    private _removeDeadPeer(stat: PeerStat, peerId: string) {
        const diff = new Date().getTime() - stat.lastSeen.getTime();
        if (diff < this._election.TIMEOUT) {
            return;
        }
        this._peers.delete(peerId);
        this._logger.log(`Deleting peer ${peerId} because not seen since ${diff}ms (isLeader? ${stat.id} === ${this._election.leaderId})`);
        // if (stat.id === this._election.leaderId) {
        //     // Haven't seen leader for TIMEOUT so we proceed to a new election
        //     this._logger.log(`Leader not seen since ${diff}ms, vote again!`);
        //     this._election.start().catch(e => this._messaging.reportError(e));
        // }
    }

    private async listenOrProxy(targetService: string, route: string, handler: MessageHandler) {
        if (this._foreignListeners.has(targetService)) {
            this._foreignListeners.get(targetService).push(handler);
            return;
        }

        if (this._foreignOngoingAsync) {
            await this._foreignOngoingAsync;
        }

        this._foreignListeners.set(targetService, [handler]);
        const thisListener = this._foreignListeners.get(targetService);
        this._foreignBindings.set(targetService,
                                  await (this._foreignOngoingAsync = this._messaging.listen(
                                      `${Messaging.internalExchangePrefix}.${targetService}`,
                                      route,
                                      (m: Message) => thisListener.forEach(cb => cb(m)))
                                        ),
                                 );
        this._foreignOngoingAsync = undefined;
    }

    private async stopListenOrProxy(targetService: string, handler: MessageHandler) {
        // debounce
        await new Promise(resolve => setImmediate(async () => { // avoids that sync exploration of arrays stops
            if (targetService === this._messaging.serviceName) {
                pull(this._proxies, handler);
                resolve();
                return;
            }

            if (this._foreignOngoingAsync) {
                await this._foreignOngoingAsync;
            }

            const listeners = this._foreignListeners.get(targetService);
            if (isNullOrUndefined(listeners)) {
                return;
            }
            pull(listeners, handler);
            if (listeners.length === 0) {
                this._foreignListeners.delete(targetService);
                await (this._foreignOngoingAsync = this._foreignBindings.get(targetService).stop());
                this._foreignOngoingAsync = undefined;
            }
            resolve();
        }));
    }
}

export interface PeerStat extends Uptime {
    id: string;
    isMaster: boolean;
    isReady: boolean;
    knownPeers: number;
    lastSeen?: Date;
    leaderId: string;
    memoryUsage: MemoryUsage;
    name: string;
}
