import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { DomainConfiguration } from '@medplum/fhirtypes';
import { randomUUID } from 'crypto';
import express from 'express';
import { pwnedPassword } from 'hibp';
import { simpleParser } from 'mailparser';
import fetch from 'node-fetch';
import request from 'supertest';
import { initApp, shutdownApp } from '../app';
import { getConfig, loadTestConfig } from '../config';
import { systemRepo } from '../fhir/repo';
import { setupPwnedPasswordMock, setupRecaptchaMock, withTestContext } from '../test.setup';
import { registerNew } from './register';

jest.mock('@aws-sdk/client-sesv2');
jest.mock('hibp');
jest.mock('node-fetch');

const app = express();

describe('Reset Password', () => {
  const testRecaptchaSecretKey = 'testrecaptchasecretkey';

  beforeAll(async () => {
    const config = await loadTestConfig();
    await initApp(app, config);
  });

  afterAll(async () => {
    await shutdownApp();
  });

  beforeEach(() => {
    (SESv2Client as unknown as jest.Mock).mockClear();
    (SendEmailCommand as unknown as jest.Mock).mockClear();
    (fetch as unknown as jest.Mock).mockClear();
    (pwnedPassword as unknown as jest.Mock).mockClear();
    setupPwnedPasswordMock(pwnedPassword as unknown as jest.Mock, 0);
    setupRecaptchaMock(fetch as unknown as jest.Mock, true);
    getConfig().recaptchaSecretKey = testRecaptchaSecretKey;
  });

  test('Blank email address', async () => {
    const res = await request(app).post('/auth/resetpassword').type('json').send({
      email: '',
      recaptchaToken: 'xyz',
    });
    expect(res.status).toBe(400);
    expect(res.body.issue[0].details.text).toBe('Valid email address is required');
    expect(res.body.issue[0].expression[0]).toBe('email');
  });

  test('Missing recaptcha', async () => {
    const res = await request(app).post('/auth/resetpassword').type('json').send({
      email: 'admin@example.com',
      recaptchaToken: '',
    });
    expect(res.status).toBe(400);
    expect(res.body.issue[0].details.text).toBe('Recaptcha token is required');
  });

  test('Incorrect recaptcha', async () => {
    setupRecaptchaMock(fetch as unknown as jest.Mock, false);

    const res = await request(app).post('/auth/resetpassword').type('json').send({
      email: 'admin@example.com',
      recaptchaToken: 'wrong',
    });
    expect(res.status).toBe(400);
    expect(res.body.issue[0].details.text).toBe('Recaptcha failed');
  });

  test('User not found', async () => {
    const res = await request(app)
      .post('/auth/resetpassword')
      .type('json')
      .send({
        email: `alex${randomUUID()}@example.com`,
        recaptchaToken: 'xyz',
      });
    expect(res.status).toBe(200);
    expect(SESv2Client).not.toHaveBeenCalled();
    expect(SendEmailCommand).not.toHaveBeenCalled();
  });

  test('Success', async () => {
    const email = `george${randomUUID()}@example.com`;

    await withTestContext(() =>
      registerNew({
        firstName: 'George',
        lastName: 'Washington',
        projectName: 'Washington Project',
        email,
        password: 'password!@#',
      })
    );

    const res2 = await request(app).post('/auth/resetpassword').type('json').send({
      email,
      recaptchaToken: 'xyz',
    });
    expect(res2.status).toBe(200);
    expect(SESv2Client).toHaveBeenCalledTimes(1);
    expect(SendEmailCommand).toHaveBeenCalledTimes(1);

    const args = (SendEmailCommand as unknown as jest.Mock).mock.calls[0][0];
    expect(args.Destination.ToAddresses[0]).toBe(email);

    const parsed = await simpleParser(args.Content.Raw.Data);
    expect(parsed.subject).toBe('Medplum Password Reset');
  });

  test('Success no send email', async () => {
    const email = `george${randomUUID()}@example.com`;

    await withTestContext(() =>
      registerNew({
        firstName: 'George',
        lastName: 'Washington',
        projectName: 'Washington Project',
        email,
        password: 'password!@#',
      })
    );

    const res2 = await request(app).post('/auth/resetpassword').type('json').send({
      email,
      recaptchaToken: 'xyz',
      sendEmail: false,
    });
    expect(res2.status).toBe(200);
    expect(SESv2Client).toHaveBeenCalledTimes(0);
    expect(SendEmailCommand).toHaveBeenCalledTimes(0);
  });

  test('Success with no recaptcha secret key and missing recaptchaToken', async () => {
    getConfig().recaptchaSecretKey = '';

    const email = `george${randomUUID()}@example.com`;

    await withTestContext(() =>
      registerNew({
        firstName: 'George',
        lastName: 'Washington',
        projectName: 'Washington Project',
        email,
        password: 'password!@#',
      })
    );

    const res2 = await request(app).post('/auth/resetpassword').type('json').send({
      email,
      recaptchaToken: '',
    });
    expect(res2.status).toBe(200);
    expect(SESv2Client).toHaveBeenCalledTimes(1);
    expect(SendEmailCommand).toHaveBeenCalledTimes(1);

    const args = (SendEmailCommand as unknown as jest.Mock).mock.calls[0][0];
    expect(args.Destination.ToAddresses[0]).toBe(email);

    const parsed = await simpleParser(args.Content.Raw.Data);
    expect(parsed.subject).toBe('Medplum Password Reset');
  });

  test('External auth', async () => {
    // Create a domain with external auth
    const domain = randomUUID() + '.example.com';
    await withTestContext(() =>
      systemRepo.createResource<DomainConfiguration>({
        resourceType: 'DomainConfiguration',
        domain,
        identityProvider: {
          authorizeUrl: 'https://example.com/oauth2/authorize',
          tokenUrl: 'https://example.com/oauth2/token',
          userInfoUrl: 'https://example.com/oauth2/userinfo',
          clientId: '123',
          clientSecret: '456',
        },
      })
    );

    const res = await request(app)
      .post('/auth/resetpassword')
      .type('json')
      .send({
        email: `alice@${domain}`,
        recaptchaToken: 'xyz',
      });
    expect(res.status).toBe(400);
    expect(res.body.issue[0].details.text).toBe(
      'Cannot reset password for external auth. Contact your system administrator.'
    );
    expect(SESv2Client).not.toHaveBeenCalled();
    expect(SendEmailCommand).not.toHaveBeenCalled();
  });

  test('Custom reCAPTCHA site key success', async () => {
    const email = `recaptcha-client${randomUUID()}@example.com`;
    const password = 'password!@#';
    const recaptchaSiteKey = 'recaptcha-site-key-' + randomUUID();
    const recaptchaSecretKey = 'recaptcha-secret-key-' + randomUUID();

    const project = await withTestContext(async () => {
      // Register and create a project
      const { project } = await registerNew({
        firstName: 'Reset',
        lastName: 'Reset',
        projectName: 'Reset Project',
        email,
        password,
      });
      // As a super admin, set the recaptcha site key
      // and the default access policy
      await systemRepo.updateResource({
        ...project,
        site: [
          {
            name: 'Test Site',
            domain: ['example.com'],
            recaptchaSiteKey,
            recaptchaSecretKey,
          },
        ],
      });
      return project;
    });

    const res2 = await request(app).post('/auth/resetpassword').type('json').send({
      email,
      projectId: project.id,
      recaptchaSiteKey,
      recaptchaToken: 'xyz',
    });
    expect(res2.status).toBe(200);
    expect(SESv2Client).toHaveBeenCalledTimes(1);
    expect(SendEmailCommand).toHaveBeenCalledTimes(1);

    const args = (SendEmailCommand as unknown as jest.Mock).mock.calls[0][0];
    expect(args.Destination.ToAddresses[0]).toBe(email);

    const parsed = await simpleParser(args.Content.Raw.Data);
    expect(parsed.subject).toBe('Medplum Password Reset');
  });

  test('Custom reCAPTCHA site key not found', async () => {
    const email = `recaptcha-client${randomUUID()}@example.com`;
    const password = 'password!@#';
    const recaptchaSiteKey = 'recaptcha-site-key-' + randomUUID();

    const project = await withTestContext(async () => {
      // Register and create a project
      const { project } = await registerNew({
        firstName: 'Reset',
        lastName: 'Reset',
        projectName: 'Reset Project',
        email,
        password,
      });
      // As a super admin, set the recaptcha site key
      // and the default access policy
      await systemRepo.updateResource({
        ...project,
        site: [
          {
            name: 'Test Site',
            domain: ['example.com'],
            recaptchaSiteKey,
          },
        ],
      });
      return project;
    });

    const res = await request(app).post('/auth/resetpassword').type('json').send({
      email,
      projectId: project.id,
      recaptchaSiteKey,
      recaptchaToken: 'xyz',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ issue: [{ code: 'invalid', details: { text: 'Invalid recaptchaSecretKey' } }] });
    expect(SESv2Client).not.toHaveBeenCalled();
    expect(SendEmailCommand).not.toHaveBeenCalled();
  });

  test('Custom reCAPTCHA site key not found', async () => {
    const email = `recaptcha-client${randomUUID()}@example.com`;
    const password = 'password!@#';
    const recaptchaSiteKey = 'recaptcha-site-key-' + randomUUID();

    const project = await withTestContext(async () => {
      // Register and create a project
      const { project } = await registerNew({
        firstName: 'Reset',
        lastName: 'Reset',
        projectName: 'Reset Project',
        email,
        password,
      });
      return project;
    });

    const res = await request(app).post('/auth/resetpassword').type('json').send({
      email,
      projectId: project.id,
      recaptchaSiteKey,
      recaptchaToken: 'xyz',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ issue: [{ code: 'invalid', details: { text: 'Invalid recaptchaSiteKey' } }] });
    expect(SESv2Client).not.toHaveBeenCalled();
    expect(SendEmailCommand).not.toHaveBeenCalled();
  });
});
