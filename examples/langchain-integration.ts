/**
 * LangChain Integration Example for keymux
 * Run with: npx tsx examples/langchain-integration.ts
 * Requires: npm i @langchain/openai @langchain/langgraph
 */

import { createNvidiaRouter, createKeyGetter, createFailoverKeyGetter, formatStats, createStatsLogger } from '../src/index';

const router = createNvidiaRouter([
  'nvapi-key-1',
  'nvapi-key-2',
  'nvapi-key-3',
  'nvapi-key-4',
  'nvapi-key-5',
  'nvapi-key-6'
], {
  defaultRpmLimit: 40,
  failureThreshold: 3
});

router.initialize();

console.log('LangChain + keymux Integration Example');
console.log('='.repeat(50));

async function basicChatOpenAI() {
  console.log('\n1. Basic ChatOpenAI with keymux\n');
  console.log('(Install @langchain/openai to run this example)');
}

async function withFailover() {
  console.log('\n2. ChatOpenAI with Automatic Failover\n');
  console.log('(Install @langchain/openai to run this example)');
}

async function withLangGraphAgent() {
  console.log('\n3. LangGraph React Agent with keymux\n');
  console.log('(Install @langchain/openai @langchain/langgraph @langchain/core to run)');
}

async function manualKeyManagement() {
  console.log('\n4. Manual Key Management for Custom Logic\n');
  console.log('(Install @langchain/openai to run this example)');
}

async function monitoringDuringExecution() {
  console.log('\n5. Monitoring Stats During Execution\n');
  console.log('(Run with actual LLM calls to see stats)');
}

async function main() {
  await basicChatOpenAI();
  await withFailover();
  await withLangGraphAgent();
  await manualKeyManagement();
  await monitoringDuringExecution();

  console.log('\n' + '='.repeat(50));
  console.log('Final Router Stats:');
  const stats = router.getOverallStats();
  console.log(`Total Keys: ${stats.totalKeys}`);
  console.log(`Healthy: ${stats.healthyKeys}`);
  console.log(`Total RPM Used: ${stats.totalRpm}/${stats.totalRpmLimit}`);
  console.log(`Overall Utilization: ${(stats.overallUtilization * 100).toFixed(1)}%`);

  router.destroy();
  console.log('\nDone!');
}

main().catch(console.error);