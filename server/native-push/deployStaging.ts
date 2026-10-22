import { execFile, spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { readFirebaseCredentials, readProbe } from './config.ts';

type Stack = {
  StackStatus: string;
  Tags?: { Key: string; Value: string }[];
  Outputs?: { OutputKey: string; OutputValue: string }[];
  Parameters?: { ParameterKey: string; ParameterValue: string }[];
};
type Rule = {
  RuleArn: string;
  Priority: string;
  IsDefault: boolean;
  Conditions: {
    Field: string;
    Values?: string[];
    HostHeaderConfig?: { Values?: string[]; RegexValues?: string[] };
    PathPatternConfig?: { Values?: string[]; RegexValues?: string[] };
  }[];
};
type DeploymentContext = {
  vpcId: string;
  subnetIds: string[];
  loadBalancerSecurityGroupId: string;
  listenerArn: string;
  listenerPriority: number;
  assignPublicIp: string;
};

const REGION = 'ap-southeast-1';
const ACCOUNT_ID = '277715911124';
const CLUSTER = 'dtbgram';
const WEB_SERVICE = 'dtbgram-web-staging';
const STACK_NAME = 'dtbgram-native-push-probe-staging';
const APPLICATION_TAG = 'dtbgram-native-push-probe';
const PROBE_SERVICE = 'dtbgram-native-push-probe-staging';
const STAGING_ORIGIN = 'https://monoverse.biz';
const EXPECTED_WEB_SECURITY_GROUP = 'sg-0465b7a04c6c594c8';
const EXPECTED_WEB_TARGET_GROUP = 'arn:aws:elasticloadbalancing:ap-southeast-1:277715911124:'
  + 'targetgroup/dtbgram-web-staging-tg/d1bbdd292a94d88d';
const EXPECTED_SUBNETS = ['subnet-0637c9fb16cc556da', 'subnet-0e241ee1eb86f23e3', 'subnet-00364472c3593505c'];
const REPOSITORY_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const TEMPLATE_PATH = resolve(REPOSITORY_ROOT, 'docker/ecs/native-push-probe-staging.template.json');
const MAX_SECRET_BYTES = 64 * 1024;
const MAX_AWS_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_LISTENER_PRIORITY = 50000;
const MIN_REMAINING_LIFETIME_MS = 20 * 60 * 1000;
const executeFile = promisify(execFile);

try {
  await runDeploymentCommand();
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : 'Staging probe operation failed'}\n`);
  process.exitCode = 1;
}

async function runDeploymentCommand() {
  const [command, ...args] = process.argv.slice(2);
  if (!['inspect', 'deploy', 'stop', 'teardown'].includes(command)
    || (command === 'deploy' ? args.length !== 2 : args.length !== 0)) {
    throw new Error('Usage: deploy-native-push-probe.sh inspect | deploy PROBE_JSON FIREBASE_JSON | stop | teardown');
  }
  const identity = await readAws<{ Account: string }>(['sts', 'get-caller-identity']);
  if (identity.Account !== ACCOUNT_ID) throw new Error('Refusing to operate outside staging AWS account 277715911124');
  const stack = await readStack();
  if (command === 'stop' || command === 'teardown') {
    if (!stack) {
      writeStatus('No staging probe stack exists');
      return;
    }
    await readAws(['ecs', 'update-service', '--cluster', CLUSTER, '--service', PROBE_SERVICE, '--desired-count', '0']);
    writeStatus('Staging probe service desired count is zero; in-flight sends may finish while tasks stop');
    if (command === 'teardown') {
      await readAws(['cloudformation', 'delete-stack', '--stack-name', STACK_NAME]);
      await runAws(['cloudformation', 'wait', 'stack-delete-complete', '--stack-name', STACK_NAME]);
      writeStatus('Removed the isolated staging probe stack, including its image repository and dedicated secrets');
    }
    return;
  }
  const context = await inspectStaging(stack);
  writeStatus(JSON.stringify({ staging: STAGING_ORIGIN, stack: STACK_NAME, ...context }));
  if (command === 'inspect') return;
  const probePath = resolve(args[0]);
  const firebasePath = resolve(args[1]);
  const probe = await readProbe(probePath);
  await readFirebaseCredentials(firebasePath);
  if (probe.disabled || new URL(probe.subscription.endpoint).origin !== STAGING_ORIGIN
    || new URL(probe.baseUrl).origin !== STAGING_ORIGIN) {
    throw new Error('Probe must be enabled and use https://monoverse.biz for both app and receiver');
  }
  if (probe.expiresAt - Date.now() < MIN_REMAINING_LIFETIME_MS) {
    throw new Error('Prepare a fresh probe: deployment needs at least 20 minutes of remaining registration lifetime');
  }
  if ((await stat(probePath)).size > MAX_SECRET_BYTES || (await stat(firebasePath)).size > MAX_SECRET_BYTES) {
    throw new Error('Each staging secret must fit within the Secrets Manager 64 KiB limit');
  }
  await runProcess('docker', ['info'], undefined, true);
  await runAws(['cloudformation', 'validate-template', '--template-body', `file://${TEMPLATE_PATH}`]);
  const currentTag = stack?.Parameters?.find(({ ParameterKey }) => ParameterKey === 'ImageTag')?.ParameterValue;
  writeStatus('Creating/updating isolated resources with the probe service stopped');
  await deployStack(context, currentTag || 'bootstrap', 0);
  const preparedStack = await readStack();
  const outputs = Object.fromEntries(preparedStack?.Outputs?.map(({ OutputKey, OutputValue }) => [
    OutputKey, OutputValue,
  ]) || []);
  if (!outputs.RepositoryUri || !outputs.ProbeSecretArn || !outputs.FirebaseSecretArn) {
    throw new Error('Probe stack did not return its repository and dedicated secret ARNs');
  }
  const password = await runAws(['ecr', 'get-login-password']);
  await runProcess('docker', ['login', '--username', 'AWS', '--password-stdin', outputs.RepositoryUri.split('/')[0]],
    password, true);
  const imageTag = `probe-${Date.now()}`;
  const image = `${outputs.RepositoryUri}:${imageTag}`;
  writeStatus('Building and pushing the separate source-only native probe image');
  await runProcess('docker', [
    'build', '--platform', 'linux/amd64', '-f', 'server/native-push/Dockerfile', '-t', image, '.',
  ]);
  await runProcess('docker', ['push', image]);
  await readProbe(probePath);
  writeStatus('Writing private JSON directly to the two dedicated Secrets Manager records');
  await readAws(['secretsmanager', 'put-secret-value', '--secret-id', outputs.ProbeSecretArn,
    '--secret-string', `file://${probePath}`]);
  await readAws(['secretsmanager', 'put-secret-value', '--secret-id', outputs.FirebaseSecretArn,
    '--secret-string', `file://${firebasePath}`]);
  writeStatus('Starting one isolated staging probe task');
  await deployStack(context, imageTag, 1);
  writeStatus('Staging probe is deployed. Verify device delivery, then unregister and run the teardown command');
}

async function inspectStaging(stack?: Stack): Promise<DeploymentContext> {
  const response = await readAws<{ services: {
    status: string;
    launchType?: string;
    capacityProviderStrategy?: { capacityProvider: string }[];
    loadBalancers: { targetGroupArn: string }[];
    networkConfiguration: { awsvpcConfiguration: {
      subnets: string[]; securityGroups: string[]; assignPublicIp: string;
    }; };
  }[]; }>(['ecs', 'describe-services', '--cluster', CLUSTER, '--services', WEB_SERVICE]);
  const service = response.services?.[0];
  const network = service?.networkConfiguration?.awsvpcConfiguration;
  const providers = service?.capacityProviderStrategy;
  const hasFargateProvider = Boolean(providers?.length)
    && providers!.every(({ capacityProvider }) => capacityProvider.startsWith('FARGATE'));
  if (!service || service.status !== 'ACTIVE' || !network
    || !(service.launchType === 'FARGATE' || hasFargateProvider)
    || !service.loadBalancers?.some(({ targetGroupArn }) => targetGroupArn === EXPECTED_WEB_TARGET_GROUP)
    || !network.securityGroups.includes(EXPECTED_WEB_SECURITY_GROUP)
    || network.subnets.length !== EXPECTED_SUBNETS.length
    || !network.subnets.every((subnet) => EXPECTED_SUBNETS.includes(subnet))
    || !['ENABLED', 'DISABLED'].includes(network.assignPublicIp)) {
    throw new Error('Staging service/network differs from the reviewed configuration; inspect before proceeding');
  }
  const targetGroups = await readAws<{ TargetGroups: { LoadBalancerArns: string[]; VpcId: string }[] }>([
    'elbv2', 'describe-target-groups', '--target-group-arns', EXPECTED_WEB_TARGET_GROUP,
  ]);
  const targetGroup = targetGroups.TargetGroups?.[0];
  if (targetGroup?.LoadBalancerArns?.length !== 1) {
    throw new Error('Staging must use one reviewed application load balancer');
  }
  const loadBalancerArn = targetGroup.LoadBalancerArns[0];
  const loadBalancers = await readAws<{ LoadBalancers: {
    Type: string; Scheme: string; VpcId: string; SecurityGroups: string[];
  }[]; }>(['elbv2', 'describe-load-balancers', '--load-balancer-arns', loadBalancerArn]);
  const loadBalancer = loadBalancers.LoadBalancers?.[0];
  if (!loadBalancer || loadBalancer.Type !== 'application' || loadBalancer.Scheme !== 'internet-facing'
    || loadBalancer.VpcId !== targetGroup.VpcId
    || !loadBalancer.SecurityGroups?.length) throw new Error('Invalid staging load balancer or VPC');
  const subnets = await readAws<{ Subnets: { VpcId: string }[] }>([
    'ec2', 'describe-subnets', '--subnet-ids', ...network.subnets,
  ]);
  if (subnets.Subnets?.length !== network.subnets.length
    || subnets.Subnets.some(({ VpcId }) => VpcId !== loadBalancer.VpcId)) {
    throw new Error('Staging subnet VPCs do not match the load balancer');
  }
  await inspectSubnetEgress(loadBalancer.VpcId, network.subnets, network.assignPublicIp);
  const attributes = await readAws<{ Attributes: { Key: string; Value: string }[] }>([
    'elbv2', 'describe-load-balancer-attributes', '--load-balancer-arn', loadBalancerArn,
  ]);
  if (attributes.Attributes?.some(({ Key, Value }) => Key === 'access_logs.s3.enabled' && Value === 'true')) {
    throw new Error('ALB access logs include capability URLs. Use an approved separate ingress/logging design; '
      + 'this script does not disable existing load-balancer logging');
  }
  const webAcl = await readAws<{ WebACL?: unknown }>([
    'wafv2', 'get-web-acl-for-resource', '--resource-arn', loadBalancerArn,
  ]);
  if (webAcl.WebACL) {
    throw new Error('Review WAF request logging/redaction before exposing the private probe capability');
  }
  const listeners = await readAws<{ Listeners: { ListenerArn: string; Protocol: string; Port: number }[] }>([
    'elbv2', 'describe-listeners', '--load-balancer-arn', loadBalancerArn,
  ]);
  const httpsListeners = listeners.Listeners?.filter(({ Protocol, Port }) => Protocol === 'HTTPS' && Port === 443);
  if (httpsListeners?.length !== 1) throw new Error('Expected exactly one staging HTTPS listener on port 443');
  const listenerArn = httpsListeners[0].ListenerArn;
  const rules = await readAws<{ Rules: Rule[] }>(['elbv2', 'describe-rules', '--listener-arn', listenerArn]);
  const ownRuleArn = stack?.Outputs?.find(({ OutputKey }) => OutputKey === 'ListenerRuleArn')?.OutputValue;
  const priority = choosePriority(rules.Rules, ownRuleArn);
  return {
    vpcId: loadBalancer.VpcId,
    subnetIds: network.subnets,
    loadBalancerSecurityGroupId: loadBalancer.SecurityGroups[0],
    listenerArn,
    listenerPriority: priority,
    assignPublicIp: network.assignPublicIp,
  };
}

async function inspectSubnetEgress(vpcId: string, subnetIds: string[], assignPublicIp: string) {
  const response = await readAws<{ RouteTables: {
    Associations: { SubnetId?: string; Main?: boolean }[];
    Routes: { DestinationCidrBlock?: string; GatewayId?: string; NatGatewayId?: string; State: string }[];
  }[]; }>(['ec2', 'describe-route-tables', '--filters', `Name=vpc-id,Values=${vpcId}`]);
  for (const subnetId of subnetIds) {
    const table = response.RouteTables.find(({ Associations }) => Associations.some(({ SubnetId }) => (
      SubnetId === subnetId
    ))) || response.RouteTables.find(({ Associations }) => Associations.some(({ Main }) => Main));
    const route = table?.Routes.find(({ DestinationCidrBlock, State }) => (
      DestinationCidrBlock === '0.0.0.0/0' && State === 'active'
    ));
    if (!route || (!route.NatGatewayId
      && !(assignPublicIp === 'ENABLED' && route.GatewayId?.startsWith('igw-')))) {
      throw new Error(`Subnet ${subnetId} has no reviewed IPv4 Internet egress for Firebase HTTPS. `
        + 'Confirm an approved NAT/public-IP route; this script does not create or alter VPC routes');
    }
  }
}

function choosePriority(rules: Rule[], ownRuleArn?: string) {
  const otherRules = rules.filter(({ RuleArn }) => RuleArn !== ownRuleArn);
  const matchingPriorities = otherRules.filter((rule) => !rule.IsDefault && checkIfCouldMatch(rule))
    .map(({ Priority }) => Number(Priority));
  const firstMatchingPriority = Math.min(MAX_LISTENER_PRIORITY + 1, ...matchingPriorities);
  const ownRule = rules.find(({ RuleArn }) => RuleArn === ownRuleArn);
  if (ownRule && Number(ownRule.Priority) < firstMatchingPriority) return Number(ownRule.Priority);
  const used = new Set(rules.filter(({ IsDefault }) => !IsDefault).map(({ Priority }) => Number(Priority)));
  for (let priority = 1; priority < firstMatchingPriority; priority += 1) {
    if (!used.has(priority)) return priority;
  }
  throw new Error('No free listener priority precedes an existing rule matching monoverse.biz/telegram-push/*. '
    + 'An explicit listener reprioritization or separate approved ingress is required; existing rules are not changed');
}

function checkIfCouldMatch(rule: Rule) {
  return rule.Conditions.every((condition) => {
    if (condition.Field !== 'host-header' && condition.Field !== 'path-pattern') return true;
    const config = condition.Field === 'host-header' ? condition.HostHeaderConfig : condition.PathPatternConfig;
    if (config?.RegexValues?.length) return true;
    const values = config?.Values || condition.Values;
    if (!values?.length) return true;
    if (condition.Field === 'path-pattern') {
      return values.some((value) => {
        const prefix = value.split(/[?*]/)[0];
        return '/telegram-push/'.startsWith(prefix) || prefix.startsWith('/telegram-push/');
      });
    }
    return values.some((value) => {
      const expression = value.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
      return new RegExp(`^${expression}$`, 'i').test('monoverse.biz');
    });
  });
}

async function readStack(): Promise<Stack | undefined> {
  let response: { Stacks: Stack[] } | undefined;
  try {
    const output = await executeFile('aws', ['cloudformation', 'describe-stacks', '--stack-name', STACK_NAME,
      '--region', REGION, '--output', 'json', '--no-cli-pager'], { maxBuffer: MAX_AWS_OUTPUT_BYTES });
    response = JSON.parse(output.stdout) as { Stacks: Stack[] };
  } catch (err) {
    if (err && typeof err === 'object' && 'stderr' in err && typeof err.stderr === 'string'
      && err.stderr.includes('does not exist')) return undefined;
  }
  if (!response) throw new Error('Cannot inspect the dedicated native probe stack');
  const stack = response.Stacks?.[0];
  if (!stack?.Tags?.some(({ Key, Value }) => Key === 'Application' && Value === APPLICATION_TAG)) {
    throw new Error('Refusing to change a stack without the expected native probe ownership tag');
  }
  if (stack.StackStatus.endsWith('_IN_PROGRESS')) throw new Error('Probe stack has an operation in progress');
  return stack;
}

async function deployStack(context: DeploymentContext, imageTag: string, desiredCount: number) {
  await runAws(['cloudformation', 'deploy', '--stack-name', STACK_NAME, '--template-file', TEMPLATE_PATH,
    '--capabilities', 'CAPABILITY_IAM', '--no-fail-on-empty-changeset', '--tags', `Application=${APPLICATION_TAG}`,
    'Environment=staging', '--parameter-overrides', `VpcId=${context.vpcId}`,
    `SubnetIds=${context.subnetIds.join(',')}`,
    `LoadBalancerSecurityGroupId=${context.loadBalancerSecurityGroupId}`, `HttpsListenerArn=${context.listenerArn}`,
    `ListenerPriority=${context.listenerPriority}`, `AssignPublicIp=${context.assignPublicIp}`, `ImageTag=${imageTag}`,
    `DesiredCount=${desiredCount}`]);
}

async function readAws<T = unknown>(args: string[]): Promise<T> {
  const output = await runAws([...args, '--output', 'json']);
  return JSON.parse(output.trim() || '{}') as T;
}

async function runAws(args: string[]) {
  try {
    const output = await executeFile('aws', [...args, '--region', REGION, '--no-cli-pager'], {
      maxBuffer: MAX_AWS_OUTPUT_BYTES,
    });
    return output.stdout;
  } catch {
    throw new Error(`AWS ${args[0]} ${args[1]} failed; inspect this operation in the AWS console`);
  }
}

function runProcess(command: string, args: string[], input?: string, isQuiet?: boolean) {
  return new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: REPOSITORY_ROOT,
      stdio: ['pipe', isQuiet ? 'ignore' : 'inherit', isQuiet ? 'ignore' : 'inherit'],
    });
    child.once('error', () => reject(new Error(`Cannot start ${command}; verify it is installed and running`)));
    child.once('close', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} ${args[0]} failed`));
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}

function writeStatus(message: string) {
  process.stdout.write(`${message}\n`);
}
