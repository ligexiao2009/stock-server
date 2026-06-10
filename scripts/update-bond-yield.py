#!/usr/bin/env python3
"""每日更新中国10年期国债收益率数据，绕过 Cloudflare 反爬"""
import json, sys, os
import cloudscraper
from datetime import datetime

OUTPUT_PATH = '/Users/yangyang/data/shinianqi.json'
API_URL = 'https://sc.macromicro.me/charts/data/14583'
AUTH_TOKEN = '5d0329f2d3c9df6f4727b138461e59eb'
PHPSESSID = 'd29362dd058c0f5631aba6b094f1fa7e'

def main():
    scraper = cloudscraper.create_scraper()
    print(f'[{datetime.now()}] 开始获取国债收益率数据...')

    resp = scraper.get(API_URL, headers={
        'Authorization': f'Bearer {AUTH_TOKEN}',
        'Referer': 'https://sc.macromicro.me/charts/14583/china-10-year-government-bond-yield',
        'Accept': 'application/json',
    }, cookies={'PHPSESSID': PHPSESSID})

    if resp.status_code != 200:
        print(f'HTTP {resp.status_code}', file=sys.stderr)
        sys.exit(1)

    data = resp.json()
    if not data.get('success'):
        print(f"API error: {data.get('msg')}", file=sys.stderr)
        sys.exit(1)

    # 统计
    series = data['data']['c:14583']['series']
    points = len(series[0]) if series else 0

    # 写入文件
    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, 'w') as f:
        json.dump(data, f, ensure_ascii=False)

    # 最新数据
    latest = series[0][-1] if series else ['?', '?']
    print(f'[{datetime.now()}] 更新完成: {points}条, 最新 {latest[0]} = {latest[1]}%')
    sys.exit(0)

if __name__ == '__main__':
    main()
