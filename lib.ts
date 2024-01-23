import { Octokit } from "@octokit/rest";
import semver from "semver";
import fs from "fs";
import path from "path";
import * as glob from "glob";

export type argvs = {
  token: string;
  repo?: string;
  repoIncludes?: string;
  pullRequestTitle: string;
};

export async function update(argv: argvs) {
  const isAlpha = argv.pullRequestTitle.includes("-alpha");
  const version = argv.pullRequestTitle.split(" v")[1];
  if (!version || !isAlpha) {
    return;
  }
  const repos = argv.repoIncludes
    ? argv.repoIncludes?.split(",").map((v) => v.trim())
    : await filterRepos(argv);
  const {
    major,
    minor,
    patch,
    prerelease: [_, alpha],
  } = semver.parse(version)!;
  const ref = (head: string) => `${head}/v${major}/v${major}.${minor}`;
  for (const repo of repos) {
    await changeVersion(
      argv.token,
      repo,
      ref("dev"),
      `${major}.${minor}.${patch}`
    );
  }
}

export async function getReops(argv: argvs): Promise<Map<string, string>> {
  const octokit = new Octokit({
    auth: `${argv.token}`,
  });
  let currentPage = 1; //当前页，初始化为1
  const maxPerPage = 100;
  const repoList = new Map<string, string>();
  while (true) {
    const repos = await octokit.rest.repos.listForOrg({
      org: "kungfu-trader",
      per_page: maxPerPage,
      page: currentPage,
    });
    repos.data.forEach((it: any) => {
      repoList.set(it.name, it.owner.login);
    });
    if (repos.data.length < maxPerPage) {
      break;
    }
    currentPage++;
  }
  console.log(repoList.size, " repositories");
  return repoList;
}

const filterRepos = async (argv: argvs) => {
  if (!argv.repo) {
    return [];
  }
  const repos = await getReops(argv);
  const rules = {
    broker: {
      prefix: "kfx-broker",
    },
    task: {
      prefix: "kfx-broker",
      prefixUi: "kfx-ui",
    },
    trader: {
      prefix: "kungfu-trader",
    },
    kungfu: {
      prefix: "kungfu",
    },
    group: {
      prefix: "kfx-group",
    },
  } as any;
  const { prefix, prefixUi } = rules[argv.repo] || {};
  if (!prefix) {
    return [];
  }
  return [...repos.keys()].filter((repoName: string) => {
    if (prefix === "kungfu") {
      return ["kungfu-license", "kungfu"].includes(repoName);
    } else {
      return (
        repoName.startsWith(prefix) ||
        (prefixUi && repoName.startsWith(prefixUi))
      );
    }
  });
};

async function changeVersion(
  token: string,
  repo: string,
  branch: string,
  version: string
) {
  const octokit = new Octokit({
    auth: token,
  });
  const lerna = await getGithubFile(octokit, repo, branch, "lerna.json");
  if (!lerna) {
    return;
  }
  const deps = getPkgNameMap();
  for (const element of lerna.content?.packages || []) {
    const folder = element.replace("/*", "");
    const menu = await getGithubMenu(octokit, repo, branch, folder);
    for (const child of menu || []) {
      const pkg = await getGithubFile(
        octokit,
        repo,
        branch,
        `${folder}/${child}/package.json`
      );
      if (pkg) {
        let count = 0;
        const { content, sha } = pkg;
        ["dependencies", "devDependencies"].forEach((item) => {
          deps.forEach((dep) => {
            if (content[item]?.[dep]) {
              content[item][dep] = `~${version} || ~${version}-0`;
              count += 1;
            }
          });
        });
        count > 0 &&
          (await updateGithubFile(
            octokit,
            repo,
            branch,
            `${folder}/${child}/package.json`,
            format(content),
            sha
          ));
      }
    }
  }
}

async function getGithubFile(
  octokit: any,
  repo: string,
  ref: string,
  path: string
) {
  return octokit
    .request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner: "kungfu-trader",
      repo,
      path,
      ref,
      headers: {
        "X-GitHub-Api-Version": "2022-11-28",
      },
    })
    .then((res: any) => {
      return {
        content: JSON.parse(
          Buffer.from(res?.data?.content, "base64").toString("utf-8")
        ),
        sha: res.data?.sha,
      };
    })
    .catch((e: any) => console.error(e));
}

async function updateGithubFile(
  octokit: any,
  repo: string,
  ref: string,
  path: string,
  content: string,
  sha: string
) {
  return octokit
    .request("PUT /repos/{owner}/{repo}/contents/{path}", {
      owner: "kungfu-trader",
      repo,
      path,
      message: `update ${path}`,
      content,
      sha,
      branch: ref,
      headers: {
        "X-GitHub-Api-Version": "2022-11-28",
      },
    })
    .catch((e: any) => console.error(e));
}

async function getGithubMenu(
  octokit: any,
  repo: string,
  ref: string,
  path: string
) {
  return octokit
    .request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner: "kungfu-trader",
      repo,
      path,
      ref,
      headers: {
        "X-GitHub-Api-Version": "2022-11-28",
      },
    })
    .then((res: { data: any[] }) => {
      return res.data.map((v) => v.name);
    })
    .catch((e: any) => console.error(e));
}

const getPkgConfig = (cwd: string, link: string): { [key: string]: any } => {
  return JSON.parse(fs.readFileSync(path.join(cwd, link), "utf-8"));
};

const getPkgNameMap = (): string[] => {
  const cwd = process.cwd();
  const hasLerna = fs.existsSync(path.join(cwd, "lerna.json"));
  const config = getPkgConfig(cwd, hasLerna ? "lerna.json" : "package.json");
  if (hasLerna) {
    const items = config.packages
      .map((x: string) =>
        glob.sync(`${x}/package.json`).reduce((acc: string[], link) => {
          const { name, publishConfig } = getPkgConfig(cwd, link);
          publishConfig && acc.push(name);
          return acc;
        }, [])
      )
      .flat();
    return items;
  }
  return [config.name];
};

function format(str: any) {
  return Buffer.from(JSON.stringify(str, null, 4), "utf-8").toString("base64");
}
