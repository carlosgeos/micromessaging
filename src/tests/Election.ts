import { expect } from 'chai';
import { random, uniq } from 'lodash';
import { Election } from '../Election';
import { Messaging } from '../Messaging';

describe('Leader Election', () => {

    let instances = 0;

    async function voteLoop(serverCount: number = random(1, 3)) {
        const servers = [];
        instances += serverCount;
        for (let j = 0; j < serverCount; j++) {
            servers.push(new Messaging('server'));
        }
        await Promise.all(servers.map(s => s.connect()));
        const ids = servers.map(s => s.serviceId);
        // ids.sort();
        // const winner = ids[ids.length - 1];
        const winners: Array<string> = [];
        await Promise.all(servers.map((s) => {
            return new Promise((resolve, reject) => {
                s.on('leader', obj => {
                    try {
                        // console.log('leader on ' + s.serviceId + ' is ' + (o as any).leaderId);
                        winners.push((obj as any).leaderId);
                        console.log(winners);
                        resolve();
                    } catch (e) {
                        reject(e);
                    }
                });
            });
        }));
        const winner = winners[0];
        winners.forEach(id => {
            try {
                expect(id).to.equal(winner);
            } catch (e) {
                ids.sort();
                // console.log({
                //     low: ids[0],
                //     high: ids[ids.length - 1],
                //     elected: winner,
                //     ids
                // });
                throw e;
            }
        });
        console.log('closing Messagings soon...');
        await Promise.all(servers.map(s => s.close()));
        ids.sort();
        return {
            low: ids[0],
            high: ids[ids.length - 1],
            elected: winner,
        };
    }

    // it('should find consensus on leadership (2 instances)', async function () {
    //     this.timeout(2000);
    //     await voteLoop(2);
    // });

    // it('should find consensus on leadership (10 instances)', async function () {
    //     this.timeout(20000);
    //     await voteLoop(10);
    // });

    // it('should find consensus on leadership (random number of instances)', async function () {
    //     this.timeout(120000);
    //     await voteLoop(random(2, 15));
    // });


    // it('should find consensus on leadership and keep a consistent one after leader dies', async function () {
    //     this.timeout(240000);
    //     const servers = new Array(4).fill(0).map(d => new Messaging('server'));
    //     let leader: string;
    //     const allConsent: { [serviceId: string]: (leaderId: string) => void } = {};
    //     servers.map(d => {
    //         d.on('leader', (info) => {
    //             allConsent[d.serviceId](info.leaderId);
    //         });
    //     });
    //     const promises: Promise<string>[] = servers.map(d => {
    //         return new Promise(resolve => {
    //             allConsent[d.serviceId] = (leaderId: string) => {
    //                 resolve(leaderId);
    //             };
    //         });
    //     });
    //     await Promise.all(servers.map(d => d.connect()));
    //     const ids = await Promise.all(promises);
    //     leader = ids[0];
    //     ids.reduce((prev, cur) => {
    //         expect(prev).to.equal(cur);
    //         return cur;
    //     }, ids[0]);

    //     const successiveLeaders = [leader];

    //     for (const [pos, server] of servers.entries()) {

    //         const promises: Promise<string>[] =
    //             servers
    //                 .filter(d => !successiveLeaders.includes(d.serviceId))
    //                 .map((d) => {
    //                     return new Promise(resolve => {
    //                         allConsent[d.serviceId] = (leaderId: string) => {
    //                             resolve(leaderId);
    //                         };
    //                     });
    //                 });

    //         if (promises.length === 0) {
    //             continue;
    //         }

    //         await new Promise((resolve, reject) => setTimeout(() => {
    //             servers.find(d => d.serviceId === leader).close()
    //                 .then(() => resolve(), e => reject(e));
    //         }, 2000));

    //         const ids = await Promise.all(promises);
    //         leader = ids[0];
    //         ids.reduce((prev, cur) => {
    //             expect(prev).to.equal(cur);
    //             return cur;
    //         }, ids[0]);
    //         successiveLeaders.push(leader);
    //     }
    //     expect(successiveLeaders).to.have.lengthOf(servers.length);
    //     expect(uniq(successiveLeaders)).to.have.lengthOf(servers.length);
    // });

    it('should be able to vote alone', async function () {
        const s = new Messaging('server');
        await s.connect();
        await new Promise((resolve, reject) => {
            s.on('leader', (lM) => {
                try {
                    expect((lM as any).leaderId).to.equal(s.serviceId);
                    resolve();
                } catch (e) {
                    reject(e);
                }
            });
        });
    });

    it('should not emit multiple times the leader', async function () {
        this.timeout(20000);
        const s = new Messaging('server');
        const s2 = new Messaging('server');
        await Promise.all(Messaging.instances.map(i => i.connect()));
        let leaderKnown1 = false,
            leaderKnown2 = false,
            rejected = false;
        await new Promise((resolve, reject) => {
            s.on('leader', (lM) => {
                if (leaderKnown1) {
                    reject(new Error('Leader was already known but we got the event again with a vote for ' + (lM as any).leaderId));
                    rejected = true;
                    return;
                }
                // console.log('leader event on 1', lM);
                leaderKnown1 = true;
            });
            s2.on('leader', (m) => {
                // console.log('leader event on 2', m);
                if (leaderKnown2) {
                    reject(new Error('Leader was already known but we got the event again with a vote for ' + (m as any).leaderId));
                    rejected = true;
                    return;
                }
                leaderKnown2 = true;
            });
            setTimeout(() => {
                if (!rejected) {
                    resolve();
                } else if (!leaderKnown1 || !leaderKnown2) {
                    reject(new Error('Unknown leader'));
                }
            }, 1000);
        });
        await new Promise((resolve, reject) => {
            setTimeout(() => resolve(), 1000);
        });
        await Promise.all([s.close(), s2.close()]);
    });

    it('should maintain leader when someone joining later', async function () {
        this.timeout(60000);
        const s = new Messaging('server');
        const s2 = new Messaging('server');
        await s.connect();
        await new Promise((resolve, reject) => {
            s.on('leader', (lM) => {
                // console.log('leader event on 1', lM);
                s2.on('leader', (m) => {
                    // console.log('leader event on 2', m);
                    try {
                        expect((m as any).leaderId).to.equal(s.serviceId);
                        resolve();
                    } catch (e) {
                        reject(e);
                    }
                });
                s2.connect().catch(reject);
            });
        });
        await new Promise((resolve, reject) => {
            setTimeout(() => resolve(), 1000);
        });
        await Promise.all([s.close(), s2.close()]);
    });

    it('should elect a new leader when the actual one seems offline', async function () {
        this.timeout(60000);
        Election.DEFAULT_TIMEOUT = 2000;
        const s = new Messaging('server');
        const s2 = new Messaging('server');
        const s3 = new Messaging('server');
        await s3.connect();
        await s.connect();
        await new Promise((resolve, reject) => {
            s.once('leader', (lM) => {
                expect(lM).to.deep.equal({leaderId: s3.serviceId});
                // console.log('leader event on 1', lM);
                // const originalLeader = (lM as any).leaderId;
                s2.once('leader', (m) => {
                    // console.log('leader event on 2', m);
                    try {
                        expect((m as any).leaderId).to.not.equal(s3.serviceId);
                        resolve();
                    } catch (e) {
                        reject(e);
                    }
                });
                s3.close().then(() => new Promise((res, rej) => {
                    // console.log('wait 1000');
                    setTimeout(() => {
                        res();
                        // console.log('resolve');
                    }, 2000);
                })).then(() => {
                    // console.log('going to connect s2');
                    return s2.connect();
                });
            });

            s3.once('leader', (m) => {
                // console.log('leader event on 3', m);
                expect(m).to.deep.equal({leaderId: s3.serviceId});
            });
        });
    });
});
