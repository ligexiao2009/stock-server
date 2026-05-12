const axios = require('axios');
const iconv = require('iconv-lite');

async function getIndices() {
    const url = 'http://qt.gtimg.cn/q=s_sh000001,s_sz399001,s_sz399006';
    
    try {
        const response = await axios.get(url, {
            responseType: 'arraybuffer' // 关键：获取原始二进制数据
        });

        // 使用 iconv-lite 将 GBK 转换为 UTF-8 字符串
        const data = iconv.decode(response.data, 'gbk');
        
        const lines = data.split(';');
        lines.forEach(line => {
            if (line.trim().length < 10) return;
            const parts = line.split('~');
            const name = parts[1];      // 指数名称
            const price = parts[3];     // 当前价格
            const change = parts[5];    // 涨幅
            
            console.log(`${name}: 价格 ${price}, 涨幅 ${change}%`);
        });
    } catch (error) {
        console.error('获取失败:', error);
    }
}

getIndices();