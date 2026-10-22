# Isolated staging probe deployment

These files prepare the single-device Phase 0 receiver for AWS. They do not implement public enrollment or resolve the missing user-bound authentication contract. Deployment is an explicit operator action; ordinary APK users are not enrolled automatically.

The staging deployment uses account `277715911124`, region `ap-southeast-1`, cluster `dtbgram`, and HTTPS host `monoverse.biz`. It discovers the existing `dtbgram-web-staging` service's load balancer, listener, VPC, subnets, and public-IP configuration, then validates them against the reviewed staging identifiers.

## Resources and scope

`docker/ecs/native-push-probe-staging.template.json` creates:

- A separate immutable-tag ECR repository and Fargate service named `dtbgram-native-push-probe-staging`.
- Two dedicated Secrets Manager records, initially empty. Only secret ARNs appear in CloudFormation and ECS definitions; the operator uploads private JSON directly afterward.
- A task execution role limited to this image repository, the two secret ARNs, and its log group. ECR login-token retrieval requires AWS's resource wildcard. The running application has no task IAM role.
- A dedicated security group accepting TCP 8787 only from the existing ALB security group, plus a narrowly scoped ALB egress rule to that probe group. Outbound TCP 443 supports Google HTTPS and AWS image/secret/log services.
- An IP target group and one new HTTPS listener rule matching both `monoverse.biz` and `/telegram-push/*`.
- A dedicated CloudWatch log group with one-day retention.

The existing web service, task definition, image, PWA subscriptions, and deployment scripts remain unchanged. The new listener rule and ALB egress rule are owned by the probe stack and removed on teardown.

The task runs as the image's `node` user. ECS injects the two Secrets Manager values into environment variables; `serve-env` writes them to a private temporary directory as `0600` files and removes the environment entries before opening its listener. Runtime source, CloudFormation, Docker build arguments, and images contain no credentials.

## Inspect before deployment

From the repository root, run:

```bash
bash docker/ecs/deploy-native-push-probe.sh inspect
```

This command performs AWS reads only. It requires Node 24 and an authenticated AWS CLI. It reports infrastructure identifiers and the proposed free listener priority, without reading or displaying secret values.

Inspection stops if the AWS account or reviewed staging network differs, if there is no supported IPv4 Internet route for Firebase, if ALB access logs expose capability URLs, if a WAF association requires logging review, or if no unused rule priority precedes existing matching rules. It never disables logging, renumbers rules, opens broad inbound access, creates NAT routes, or changes existing network policy to bypass a failed check.

For a failed check, inspect the named resource and obtain the specific missing input: an approved listener priority/ingress design, capability-safe logging configuration, or existing Internet egress. Private VPC endpoint policies, endpoint security groups, network ACLs, and firewall restrictions must also allow the new probe task to reach ECR, Secrets Manager, CloudWatch, and Google HTTPS; the script does not alter those resources.

## Prepare and deploy

Complete the controlled native Firebase smoke check described in [README.md](README.md), and review the read-only inspection result. Export a fresh APK setup and prepare receiver files using `https://monoverse.biz` as the public origin. Each input secret must fit the Secrets Manager limit of 64 KiB and remain private. The deploy command requires at least 20 minutes remaining on the one-hour registration.

Run the local checks before deployment:

```bash
npm run check:ts
npx tsc -p server/native-push/tsconfig.json --noEmit
bash -n docker/ecs/deploy-native-push-probe.sh
```

Deploy explicitly with the two private input paths:

```bash
bash docker/ecs/deploy-native-push-probe.sh deploy \
  /absolute/private/path/probe.json \
  /absolute/private/path/firebase-service-account.json
```

The command validates the CloudFormation template through AWS, creates or updates only its tagged probe stack with desired count zero, builds/pushes a separate Linux AMD64 image, writes the two private files directly to their dedicated Secrets Manager records, then starts one task. No secret value is passed as a command-line argument or CloudFormation parameter. It does not source the website `.env` file.

This action creates billable AWS resources and uploads copies of the two supplied private files to staging Secrets Manager. The operator needs appropriate CloudFormation, IAM role/pass-role, ECS, ECR, EC2 security-group, ELB rule/target-group, Logs, Secrets Manager, and read-only WAF permissions. Use the organization's existing deployment identity; the script does not create or broaden operator permissions.

Register the enrollment in the APK only after deployment succeeds and its target is healthy. Verify actual Telegram delivery/decryption, native preview text, and tap routing. Check `/ecs/dtbgram-native-push-probe-staging` for content-free outcome logs. Successful stack deployment or Firebase acknowledgement alone does not prove device display.

If deployment fails, inspect CloudFormation events and ECS stopped-task reasons for this stack/service. Do not print injected environment variables or secret records while troubleshooting. Run the teardown command once evidence is collected.

## Stop and teardown

ECS environment injection is a startup snapshot. Updating the Secrets Manager record or a local `probe.json` does **not** update a running task's configuration. Use the explicit stop action before changing settings, switching accounts, or logging out:

```bash
bash docker/ecs/deploy-native-push-probe.sh stop
```

This scales only the native probe service to zero. A Firebase request already in progress can finish while the task stops. No subsequent automatic client registration is enabled.

Unregister the exact Telegram subscription in the APK console:

```js
await window.nativePushProbe.unregister();
```

Then remove the dedicated infrastructure:

```bash
bash docker/ecs/deploy-native-push-probe.sh teardown
```

Teardown scales the probe service to zero and deletes its CloudFormation stack, including its private ECR images, dedicated secret copies, log group, role, listener rule, and security-group resources. It does not remove the original local Firebase credentials or change the existing staging web service.

Every task refuses new sends after the configuration's original expiry, at most one hour after preparation. Firebase can still deliver previously accepted messages within their TTL. ECS may restart an expired unhealthy task while desired count remains one; it still refuses the expired configuration. Run stop/teardown to end resource usage. Refreshing or rotating configuration requires a reviewed new deployment and fresh enrollment.

## Remaining release gates

The controlled receiver still needs evidence for real Telegram endpoint compatibility, captions, VAPID/sender authorization, native tag behavior, and foreground/cold-start display. Multi-user enrollment additionally needs verified account ownership, live lifecycle/privacy synchronization, durable event state/retries, and supported native read/delete cleanup. Declining a separate verification bot does not make the public website API key sufficient identity proof.

References: [ECS Secrets Manager injection and rotation](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/secrets-envvar-secrets-manager.html), [CloudFormation empty Secrets Manager records](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-secretsmanager-secret.html), [ECR deletion behavior](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-ecr-repository.html).
