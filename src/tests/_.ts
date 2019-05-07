import { Messaging } from '../Messaging';

const wait = async (ms: number) => {
    return new Promise((r, j) => setTimeout(r, ms));
};

afterEach(async () => {
    await Promise.all(Messaging.instances.map(i => i.close(true, true)));
    global.gc();
});
