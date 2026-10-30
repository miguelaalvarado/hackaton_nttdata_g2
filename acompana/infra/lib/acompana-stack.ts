import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';
import * as path from 'node:path';

/**
 * Despliegue de referencia: ECS Fargate (api, worker, web) + RDS PostgreSQL + Secrets Manager + ALB.
 * Bedrock y AWS End User Messaging Social se habilitan por variables de entorno y permisos IAM.
 * No es necesario para la demo local. Revisar costos y región antes de desplegar.
 */
export class AcompanaStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    const root = path.join(__dirname, '..', '..');

    const vpc = new ec2.Vpc(this, 'Vpc', { maxAzs: 2, natGateways: 1 });
    const cluster = new ecs.Cluster(this, 'Cluster', { vpc });

    const db = new rds.DatabaseInstance(this, 'Db', {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 }),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      credentials: rds.Credentials.fromGeneratedSecret('acompana'),
      databaseName: 'acompana',
      storageEncrypted: true,
      backupRetention: Duration.days(7),
      removalPolicy: RemovalPolicy.SNAPSHOT,
    });

    // Secretos (se cargan a mano en Secrets Manager; nunca en el repositorio).
    const appSecrets = new secrets.Secret(this, 'AppSecrets', {
      description: 'JWT_SECRET, ANTHROPIC_API_KEY, WHATSAPP_TOKEN, WHATSAPP_APP_SECRET',
      generateSecretString: { secretStringTemplate: JSON.stringify({}), generateStringKey: 'JWT_SECRET', excludePunctuation: true },
    });

    const appImage = ecs.ContainerImage.fromAsset(root, { target: 'app' });
    const dbSecret = db.secret!;
    const env = { LLM_PROVIDER: 'bedrock', BEDROCK_MODEL: 'anthropic.claude-opus-5-5', AWS_REGION: this.region, MESSAGING_CHANNEL: 'simulator' };
    const appSecretsEnv = {
      JWT_SECRET: ecs.Secret.fromSecretsManager(appSecrets, 'JWT_SECRET'),
      DB_PASSWORD: ecs.Secret.fromSecretsManager(dbSecret, 'password'),
    };
    // DATABASE_URL se arma en el arranque a partir de DB_HOST/DB_PASSWORD (ver README, sección AWS).
    const dbEnv = { DB_HOST: db.dbInstanceEndpointAddress, DB_USER: 'acompana', DB_NAME: 'acompana' };

    const api = new ecsPatterns.ApplicationLoadBalancedFargateService(this, 'Api', {
      cluster,
      cpu: 512,
      memoryLimitMiB: 1024,
      desiredCount: 1,
      taskImageOptions: {
        image: appImage,
        containerPort: 4000,
        environment: { ...env, ...dbEnv, API_PORT: '4000' },
        secrets: appSecretsEnv,
        command: ['sh', '-c', 'export DATABASE_URL="postgresql://$DB_USER:$DB_PASSWORD@$DB_HOST:5432/$DB_NAME" && npm run migrate -w @acompana/db && npm run start -w @acompana/api'],
      },
    });
    api.targetGroup.configureHealthCheck({ path: '/health' });

    const workerTask = new ecs.FargateTaskDefinition(this, 'WorkerTask', { cpu: 256, memoryLimitMiB: 512 });
    workerTask.addContainer('worker', {
      image: appImage,
      environment: { ...env, ...dbEnv },
      secrets: appSecretsEnv,
      command: ['sh', '-c', 'export DATABASE_URL="postgresql://$DB_USER:$DB_PASSWORD@$DB_HOST:5432/$DB_NAME" && npm run start -w @acompana/worker'],
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'worker' }),
    });
    const worker = new ecs.FargateService(this, 'Worker', { cluster, taskDefinition: workerTask, desiredCount: 1 });

    const web = new ecsPatterns.ApplicationLoadBalancedFargateService(this, 'Web', {
      cluster,
      cpu: 256,
      memoryLimitMiB: 512,
      taskImageOptions: {
        image: ecs.ContainerImage.fromAsset(root, { target: 'web' }),
        containerPort: 3000,
        // La web lee la URL de la API en tiempo de ejecución (app/layout.tsx).
        environment: { API_PUBLIC_URL: `http://${api.loadBalancer.loadBalancerDnsName}` },
      },
    });

    // CORS: la API acepta llamadas solo desde la web desplegada.
    api.taskDefinition.defaultContainer!.addEnvironment('WEB_ORIGIN', `http://${web.loadBalancer.loadBalancerDnsName}`);

    for (const svc of [api.service, worker]) {
      db.connections.allowDefaultPortFrom(svc);
      // Bedrock (asistente) y AWS End User Messaging Social (WhatsApp, Etapa 2).
      svc.taskDefinition.taskRole.addToPrincipalPolicy(
        new iam.PolicyStatement({ actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream', 'social-messaging:SendWhatsAppMessage'], resources: ['*'] }),
      );
    }

    new CfnOutput(this, 'ApiUrl', { value: `http://${api.loadBalancer.loadBalancerDnsName}` });
    new CfnOutput(this, 'WebUrl', { value: `http://${web.loadBalancer.loadBalancerDnsName}` });
  }
}
