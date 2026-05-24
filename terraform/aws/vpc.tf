locals {
  public_subnet_cidrs  = [for i, _ in var.availability_zones : cidrsubnet(var.vpc_cidr, 8, i)]
  private_subnet_cidrs = [for i, _ in var.availability_zones : cidrsubnet(var.vpc_cidr, 8, i + 10)]
}

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = merge(var.tags, {
    Name = "${var.cluster_name}-vpc"
  })
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = merge(var.tags, {
    Name = "${var.cluster_name}-igw"
  })
}

resource "aws_subnet" "public" {
  count             = length(var.availability_zones)
  vpc_id            = aws_vpc.main.id
  cidr_block        = local.public_subnet_cidrs[count.index]
  availability_zone = var.availability_zones[count.index]

  map_public_ip_on_launch = true

  tags = merge(var.tags, {
    Name                                        = "${var.cluster_name}-public-${var.availability_zones[count.index]}"
    "kubernetes.io/role/elb"                    = "1"
    "kubernetes.io/cluster/${var.cluster_name}" = "shared"
  })
}

resource "aws_subnet" "private" {
  count             = length(var.availability_zones)
  vpc_id            = aws_vpc.main.id
  cidr_block        = local.private_subnet_cidrs[count.index]
  availability_zone = var.availability_zones[count.index]

  tags = merge(var.tags, {
    Name                                        = "${var.cluster_name}-private-${var.availability_zones[count.index]}"
    "kubernetes.io/role/internal-elb"           = "1"
    "kubernetes.io/cluster/${var.cluster_name}" = "shared"
  })
}

resource "aws_eip" "nat" {
  count  = length(var.availability_zones)
  domain = "vpc"

  tags = merge(var.tags, {
    Name = "${var.cluster_name}-nat-eip-${count.index}"
  })
}

resource "aws_nat_gateway" "main" {
  count         = length(var.availability_zones)
  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id

  tags = merge(var.tags, {
    Name = "${var.cluster_name}-nat-${var.availability_zones[count.index]}"
  })

  depends_on = [aws_internet_gateway.main]
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = merge(var.tags, {
    Name = "${var.cluster_name}-public-rt"
  })
}

resource "aws_route_table_association" "public" {
  count          = length(var.availability_zones)
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "private" {
  count  = length(var.availability_zones)
  vpc_id = aws_vpc.main.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main[count.index].id
  }

  tags = merge(var.tags, {
    Name = "${var.cluster_name}-private-rt-${var.availability_zones[count.index]}"
  })
}

resource "aws_route_table_association" "private" {
  count          = length(var.availability_zones)
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[count.index].id
}

resource "aws_vpc_peering_connection" "target" {
  count = var.target_vpc_id != "" ? 1 : 0

  vpc_id      = aws_vpc.main.id
  peer_vpc_id = var.target_vpc_id
  auto_accept = true

  tags = merge(var.tags, {
    Name = "${var.cluster_name}-to-target"
  })
}

resource "aws_route" "to_target" {
  count = var.target_vpc_id != "" ? length(var.availability_zones) : 0

  route_table_id            = aws_route_table.private[count.index].id
  destination_cidr_block    = var.target_cidr
  vpc_peering_connection_id = aws_vpc_peering_connection.target[0].id
}

data "aws_route_tables" "target" {
  count  = var.target_vpc_id != "" ? 1 : 0
  vpc_id = var.target_vpc_id
}

resource "aws_route" "from_target" {
  count = var.target_vpc_id != "" ? length(data.aws_route_tables.target[0].ids) : 0

  route_table_id            = tolist(data.aws_route_tables.target[0].ids)[count.index]
  destination_cidr_block    = var.vpc_cidr
  vpc_peering_connection_id = aws_vpc_peering_connection.target[0].id
}

resource "aws_security_group_rule" "target_inbound_kafka" {
  count = var.target_vpc_id != "" && var.target_security_group_id != "" ? 1 : 0

  type              = "ingress"
  security_group_id = var.target_security_group_id
  description       = "Allow OMB workers to reach Redpanda Kafka API"
  from_port         = 9092
  to_port           = 9093
  protocol          = "tcp"
  cidr_blocks       = [var.vpc_cidr]
}
