import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SITE_PROFILES,
  applySiteProfile,
  normalizeSiteProfile,
  siteProfileLabel,
  siteProfileRules,
} from '../src/site-profiles.js';

test('普通网站策略保持原始建站配置不变', () => {
  const input = { domain: 'www.example.com', proxy_timeout: 30, proxy_cache: [{ type: 'all', expire: 1, unit: 'h' }] };
  assert.deepEqual(applySiteProfile(input, 'web'), input);
  assert.notEqual(applySiteProfile(input, 'web'), input);
  assert.equal(normalizeSiteProfile(), 'web');
  assert.equal(siteProfileLabel('web'), '普通网站');
});

test('未知建站策略被拒绝', () => {
  assert.throws(() => normalizeSiteProfile('allow-everything'), /建站策略无效/);
  assert.throws(() => applySiteProfile({}, 'allow-everything'), /建站策略无效/);
});

test('全协议 AI 策略只生成已知 API 路径并启用长连接配置', () => {
  const customRule = {
    matcher: [{ item: 'ip', op: '=', value: '192.0.2.10', value2: '' }],
    filter: { type: 'captcha_filter' }, mode: 'break', des: '客户自定义规则', enable: 1,
  };
  const output = applySiteProfile({
    proxy_timeout: 30,
    proxy_cache: [{ type: 'all', expire: 1, unit: 'h' }],
    extra_cc_rule: JSON.stringify([customRule]),
  }, 'mixed_ai');

  assert.equal(Object.keys(SITE_PROFILES).length, 8);
  assert.equal(output.proxy_timeout, 600);
  assert.equal(output.proxy_http_version, '1.1');
  assert.equal(output.websocket_enable, 1);
  assert.deepEqual(output.proxy_cache, []);
  assert.deepEqual(output.extra_cc_rule.at(-1), customRule);
  assert.ok(output.extra_cc_rule.length > 8);
  assert.ok(output.extra_cc_rule.every(rule => rule.mode === 'break'));
  assert.ok(output.extra_cc_rule.slice(0, -1).every(rule => rule.filter.type === 'req_rate'
    && rule.filter.max_challenge === 11111 && rule.filter.max_per_uri === 11111));

  const patterns = output.extra_cc_rule.slice(0, -1).map(rule => rule.matcher[0].value);
  assert.ok(patterns.some(pattern => new RegExp(pattern).test('/v1/responses')));
  assert.ok(patterns.some(pattern => new RegExp(pattern).test('/v1/messages')));
  assert.ok(patterns.some(pattern => new RegExp(pattern).test('/v1beta/models/gemini-2.5-pro:generateContent')));
  assert.ok(patterns.some(pattern => new RegExp(pattern).test('/openai/deployments/gpt-5/chat/completions')));
  assert.ok(patterns.some(pattern => new RegExp(pattern).test('/compatible-mode/v1/embeddings')));
  for (const blocked of ['/', '/login', '/api/v1/auth/login', '/api/v1/users']) {
    assert.equal(patterns.some(pattern => new RegExp(pattern).test(blocked)), false, blocked);
  }
});

test('单协议策略不意外放行其他协议且保留更长超时', () => {
  const openai = applySiteProfile({ proxy_timeout: 900 }, 'openai');
  assert.equal(openai.proxy_timeout, 900);
  assert.equal(openai.extra_cc_rule.length, 1);
  assert.match(openai.extra_cc_rule[0].matcher[0].value, /responses/);
  assert.equal(new RegExp(openai.extra_cc_rule[0].matcher[0].value).test('/v1/messages'), false);
  assert.equal(siteProfileRules('anthropic').length, 1);
});

test('损坏的客户自定义规则不会被静默吞掉', () => {
  assert.throws(() => applySiteProfile({ extra_cc_rule: '{bad json' }, 'openai'), /自定义 CC 规则格式无效/);
});
