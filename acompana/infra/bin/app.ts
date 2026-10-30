import { App } from 'aws-cdk-lib';
import { AcompanaStack } from '../lib/acompana-stack';

const app = new App();
new AcompanaStack(app, 'Acompana', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1' },
});
