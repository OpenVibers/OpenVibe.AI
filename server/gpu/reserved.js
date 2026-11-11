'use strict';
/**
 * A reserved server: a fixed monthly box the owner registers by endpoint and monthly price
 * (Hetzner GEX44 class). Nothing is rented by an API and no account is created here.
 *
 * Its hourly cost is the monthly price ÷ 730 (the hours in a month), exact integer nano-USD. The
 * "instance" is the endpoint itself: createInstance answers at once, showInstance reports the
 * registered endpoint, and destroyInstance gives the row back without touching the box — only the
 * owner can stop a machine he pays for monthly.
 */
const money = require('./money');

function reservedAdapter({ endpoint = '', monthlyNano = null, name = 'reserved' } = {}) {
    const url = String(endpoint || '').replace(/\/+$/, '');
    const monthly = monthlyNano == null || monthlyNano === '' ? null : String(monthlyNano);
    const hourly = monthly != null && /^[0-9]+$/.test(monthly) ? (BigInt(monthly) / 730n).toString() : null;
    const usd = hourly == null ? null : money.usdText(BigInt(hourly)).slice(1);

    return {
        id: 'reserved',
        label: 'Reserved server',
        baseUrl: url,
        billing: 'monthly, registered by the owner; hourly is the monthly price ÷ 730',

        async searchOffers(req = {}) {
            if (!url || hourly == null) return [];
            if (req.maxPricePerHour && Number(usd) > Number(req.maxPricePerHour)) return [];
            return [{
                id: 'reserved:' + name,
                marketplace: 'reserved',
                gpu_name: String(name || 'reserved server'),
                gpu_ram_mb: Number(req.vramMb) || 0,
                num_gpus: 1,
                disk_gb: Number(req.diskGb) || 0,
                price_per_hour: usd,
                reliability: 0.99,
                region: '',
                interruptible: false,
            }];
        },

        async createInstance(offer, spec, opts = {}) {
            if (!url) throw Object.assign(new Error('no reserved server endpoint is registered'), { status: 422 });
            return { remote_id: 'reserved:' + String(name || spec.key), endpoint: url, state: 'running', reserved: true };
        },

        async showInstance(remoteId) {
            if (!url) return { remote_id: remoteId, state: 'deleted', deleted: true, endpoint: '' };
            return { remote_id: remoteId, state: 'running', endpoint: url, reserved: true };
        },

        async destroyInstance() {
            // The box keeps running: the owner pays for it monthly either way. The row is released.
            return true;
        },
    };
}

module.exports = { reservedAdapter };
